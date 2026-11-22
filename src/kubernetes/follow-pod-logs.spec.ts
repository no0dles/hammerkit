import { PassThrough, Writable } from 'stream'
import { followPodLogs, MAX_LOG_LINE_CHARS } from './follow-pod-logs'
import { KubernetesInstance } from './kubernetes-instance'

function podWith(status: object) {
  return { metadata: { name: 'web-1' }, status: { containerStatuses: [{ name: 'web', ...status }] } }
}

function cluster(...polls: object[][]) {
  const listNamespacedPod = vi.fn()
  for (const items of polls) {
    listNamespacedPod.mockResolvedValueOnce({ items })
  }
  listNamespacedPod.mockResolvedValue({ items: polls[polls.length - 1] })
  const controllers: AbortController[] = []
  const log = vi.fn(async (_ns: string, _pod: string, _container: string, stream: Writable) => {
    stream.write('started\nlistening on 8080\n')
    const controller = new AbortController()
    controllers.push(controller)
    return controller
  })
  const readNamespacedPodLog = vi.fn().mockResolvedValue('boom\nexit\n')
  const instance = {
    coreApi: { listNamespacedPod, readNamespacedPodLog },
    log: { log },
  } as unknown as KubernetesInstance
  return { instance, listNamespacedPod, log, readNamespacedPodLog, controllers }
}

const tick = () => new Promise((resolve) => setImmediate(resolve))

describe('followPodLogs', () => {
  const running = podWith({ containerID: 'c://2', state: { running: {} }, restartCount: 0 })

  it('follows the instance that runs, once over every look', async () => {
    const { instance, log, listNamespacedPod } = cluster([running])
    const lines: string[] = []
    const follower = followPodLogs(instance, 'ns', 'id=web', 'web', (line) => lines.push(line), {
      pollInterval: 1_000_000,
    })
    await follower.settle()
    await follower.settle()
    await tick()
    follower.stop()

    expect(listNamespacedPod).toHaveBeenCalledWith({ namespace: 'ns', labelSelector: 'id=web' })
    expect(log).toHaveBeenCalledTimes(1)
    expect(log).toHaveBeenCalledWith('ns', 'web-1', 'web', expect.anything(), { follow: true, timestamps: true })
    expect(lines).toEqual(['started', 'listening on 8080'])
  })

  it('reads an instance that crashed before it was seen, once, then follows the one that runs', async () => {
    const restarted = podWith({
      containerID: 'c://2',
      state: { running: {} },
      restartCount: 1,
      lastState: { terminated: { containerID: 'c://1', exitCode: 1 } },
    })
    const { instance, log, readNamespacedPodLog } = cluster([restarted])
    const lines: string[] = []
    const follower = followPodLogs(instance, 'ns', 'id=web', 'web', (line) => lines.push(line), {
      pollInterval: 1_000_000,
    })
    await follower.settle()
    await tick()
    follower.stop()

    expect(readNamespacedPodLog).toHaveBeenCalledTimes(1)
    expect(readNamespacedPodLog).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'web-1', namespace: 'ns', container: 'web', previous: true })
    )
    expect(log).toHaveBeenCalledTimes(1)
    expect(lines).toEqual(['boom', 'exit', 'started', 'listening on 8080'])
  })

  it('does not read again an instance it followed while it ran, once it crashed', async () => {
    const crashed = podWith({
      containerID: '',
      state: { waiting: { reason: 'CrashLoopBackOff' } },
      restartCount: 1,
      lastState: { terminated: { containerID: 'c://2', exitCode: 1 } },
    })
    const { instance, readNamespacedPodLog } = cluster([running], [crashed])
    const follower = followPodLogs(instance, 'ns', 'id=web', 'web', () => undefined, { pollInterval: 1_000_000 })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const settled = follower.settle()
      await vi.advanceTimersByTimeAsync(10_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
    follower.stop()

    expect(readNamespacedPodLog).not.toHaveBeenCalled()
  })

  it('passes over a pod that goes, of a Deployment deleted before', async () => {
    const going = { ...running, metadata: { name: 'web-0', deletionTimestamp: new Date() } }
    const { instance, log } = cluster([going])
    const follower = followPodLogs(instance, 'ns', 'id=web', 'web', () => undefined, { pollInterval: 1_000_000 })
    await follower.settle()
    follower.stop()
    expect(log).not.toHaveBeenCalled()
  })

  it('reads an instance that ended up to a limit', async () => {
    const ended = podWith({ containerID: 'c://1', state: { terminated: { exitCode: 1 } }, restartCount: 0 })
    const { instance, readNamespacedPodLog } = cluster([ended])
    const follower = followPodLogs(instance, 'ns', 'id=web', 'web', () => undefined, { pollInterval: 1_000_000 })
    await follower.settle()
    follower.stop()
    expect(readNamespacedPodLog).toHaveBeenCalledWith(
      expect.objectContaining({ previous: false, limitBytes: 1024 * 1024 })
    )
  })

  it('looks again at once when the log it follows ends, not only at its interval', async () => {
    const { instance, listNamespacedPod, log } = cluster([running])
    const streams: Writable[] = []
    log.mockImplementation(async (_ns, _pod, _container, stream: Writable) => {
      streams.push(stream)
      return new AbortController()
    })
    const follower = followPodLogs(instance, 'ns', 'id=web', 'web', () => undefined, {
      pollInterval: 1_000_000,
      followingInterval: 1_000_000,
    })
    for (let i = 0; i < 10 && streams.length === 0; i++) {
      await tick()
    }
    expect(streams).toHaveLength(1)
    const looked = listNamespacedPod.mock.calls.length
    streams[0].end()
    for (let i = 0; i < 10 && listNamespacedPod.mock.calls.length === looked; i++) {
      await tick()
    }
    follower.stop()
    expect(listNamespacedPod.mock.calls.length).toBe(looked + 1)
  })

  // a follow that breaks off (a quiet stretch past the client's body timeout, a proxy) lost
  // all the instance wrote afterwards, its failure included
  it('follows again from where it got to when the log it follows breaks off while it runs', async () => {
    const ended = podWith({ containerID: 'c://2', state: { terminated: { exitCode: 1 } }, restartCount: 0 })
    const { instance, log, readNamespacedPodLog } = cluster([running], [running], [ended])
    // as the client does: the response is piped into the stream it is given
    const streams: PassThrough[] = []
    log.mockImplementation(async (_ns, _pod, _container, stream: Writable) => {
      const source = new PassThrough()
      source.pipe(stream)
      streams.push(source)
      return new AbortController()
    })
    readNamespacedPodLog.mockResolvedValue(
      [
        '2026-11-14T08:00:01.2Z second',
        '2026-11-14T08:00:01.2Z third',
        '2026-11-14T08:00:01.2Z fourth',
        '2026-11-14T08:00:02.000000001Z failed: boom',
        '',
      ].join('\n')
    )
    const lines: string[] = []
    const follower = followPodLogs(instance, 'ns', 'id=web', 'web', (line) => lines.push(line), {
      pollInterval: 1_000_000,
      followingInterval: 1_000_000,
    })
    const until = async (done: () => boolean) => {
      for (let i = 0; i < 50 && !done(); i++) {
        await tick()
      }
    }
    await until(() => streams.length === 1)
    streams[0].write('2026-11-14T08:00:00.5Z first\n2026-11-14T08:00:01.2Z second\n')
    streams[0].end()
    // looked at again at once: it still runs, so it is followed again from that second
    await until(() => streams.length === 2)
    expect(log).toHaveBeenLastCalledWith('ns', 'web-1', 'web', expect.anything(), {
      follow: true,
      timestamps: true,
      sinceTime: '2026-11-14T08:00:01Z',
    })
    streams[1].write('2026-11-14T08:00:01.2Z second\n2026-11-14T08:00:01.2Z third\n')
    streams[1].destroy(new Error('terminated'))
    // it ended meanwhile: the rest is read, past what was read
    await follower.settle()
    follower.stop()

    expect(readNamespacedPodLog).toHaveBeenCalledWith(
      expect.objectContaining({ previous: false, timestamps: true, sinceSeconds: expect.any(Number) })
    )
    expect(lines).toEqual(['first', 'second', 'third', 'fourth', 'failed: boom'])
  })

  // a server that restarted reads on from where the run's log got to with the one before
  describe('from where an earlier follower got to', () => {
    const from = { container: 'c://2', at: '2026-11-14T08:00:01.200000000', count: 2 }

    it('follows an instance it read from its line, without a line twice or one missing', async () => {
      const { instance, log } = cluster([running])
      log.mockImplementation(async (_ns, _pod, _container, stream: Writable) => {
        stream.write(
          [
            '2026-11-14T08:00:01.2Z second',
            '2026-11-14T08:00:01.2Z third',
            '2026-11-14T08:00:01.2Z fourth',
            '2026-11-14T08:00:03Z fifth',
            '',
          ].join('\n')
        )
        return new AbortController()
      })
      const lines: [string, unknown][] = []
      const follower = followPodLogs(instance, 'ns', 'id=web', 'web', (line, cursor) => lines.push([line, cursor]), {
        pollInterval: 1_000_000,
        from: [from],
      })
      await follower.settle()
      await tick()
      follower.stop()

      expect(log).toHaveBeenCalledWith('ns', 'web-1', 'web', expect.anything(), {
        follow: true,
        timestamps: true,
        sinceTime: '2026-11-14T08:00:01Z',
      })
      // with each line, where the log got to: the next follower reads on from there
      expect(lines).toEqual([
        ['fourth', { container: 'c://2', at: '2026-11-14T08:00:01.200000000', count: 3 }],
        ['fifth', { container: 'c://2', at: '2026-11-14T08:00:03.000000000', count: 1 }],
      ])
    })

    it('reads from the start what a cursor that is no list says nothing of', async () => {
      const { instance } = cluster([running])
      const lines: string[] = []
      // the record of a task named as a property of an object: what it inherits is no cursor
      const follower = followPodLogs(instance, 'ns', 'id=web', 'web', (line) => lines.push(line), {
        pollInterval: 1_000_000,
        from: Object.prototype.constructor as any,
      })
      await follower.settle()
      await tick()
      follower.stop()
      expect(lines).toEqual(['started', 'listening on 8080'])
    })

    it('reads an instance it read that ended on from its line', async () => {
      const ended = podWith({ containerID: 'c://2', state: { terminated: { exitCode: 0 } }, restartCount: 0 })
      const { instance, readNamespacedPodLog } = cluster([ended])
      readNamespacedPodLog.mockResolvedValue(
        ['2026-11-14T08:00:00.5Z first', '2026-11-14T08:00:01.2Z second', '2026-11-14T08:00:01.2Z third', ''].join('\n')
      )
      const lines: string[] = []
      const follower = followPodLogs(instance, 'ns', 'id=web', 'web', (line) => lines.push(line), {
        pollInterval: 1_000_000,
        from: [{ ...from, count: 1 }],
      })
      await follower.settle()
      follower.stop()
      expect(lines).toEqual(['third'])
    })

    it('reads every instance from where it got in that one: the one that crashed before too', async () => {
      const restarted = podWith({
        containerID: 'c://2',
        state: { running: {} },
        restartCount: 1,
        lastState: { terminated: { containerID: 'c://1', exitCode: 1 } },
      })
      const { instance, log, readNamespacedPodLog } = cluster([restarted])
      // what the crashed one wrote, all of which the follower before read
      readNamespacedPodLog.mockResolvedValue(
        ['2026-11-14T08:00:00.1Z boom', '2026-11-14T08:00:00.2Z exit', ''].join('\n')
      )
      log.mockImplementation(async (_ns, _pod, _container, stream: Writable) => {
        stream.write('2026-11-14T08:00:01.2Z second\n2026-11-14T08:00:01.2Z third\n2026-11-14T08:00:02Z up\n')
        return new AbortController()
      })
      const lines: string[] = []
      const follower = followPodLogs(instance, 'ns', 'id=web', 'web', (line) => lines.push(line), {
        pollInterval: 1_000_000,
        from: [{ container: 'c://1', at: '2026-11-14T08:00:00.200000000', count: 1 }, from],
      })
      await follower.settle()
      await tick()
      follower.stop()
      expect(lines).toEqual(['up'])
    })

    it('reads the pod a Job retried from its start, and the one it read before from its line', async () => {
      const pod = (name: string, id: string, state: object) => ({
        metadata: { name },
        status: { containerStatuses: [{ name: 'cmd-1', containerID: id, state, restartCount: 0 }] },
      })
      const { instance, log, readNamespacedPodLog } = cluster([
        pod('job-a', 'c://1', { terminated: { exitCode: 1 } }),
        pod('job-b', 'c://3', { running: {} }),
      ])
      readNamespacedPodLog.mockResolvedValue(
        ['2026-11-14T08:00:00.1Z try one', '2026-11-14T08:00:00.2Z failed', ''].join('\n')
      )
      log.mockImplementation(async (_ns, _pod, _container, stream: Writable) => {
        stream.write('2026-11-14T08:00:05Z try two\n')
        return new AbortController()
      })
      const lines: string[] = []
      const follower = followPodLogs(instance, 'ns', 'job-name=job', 'cmd-1', (line) => lines.push(line), {
        pollInterval: 1_000_000,
        from: [{ container: 'c://1', at: '2026-11-14T08:00:00.200000000', count: 1 }],
      })
      await follower.settle()
      await tick()
      follower.stop()
      // the first pod's lines were all read before the restart; the retry is new
      expect(lines).toEqual(['try two'])
    })
  })

  it('cuts a follow that does not end after its instance ended, and reads the rest', async () => {
    const ended = podWith({ containerID: 'c://2', state: { terminated: { exitCode: 1 } }, restartCount: 0 })
    const { instance, log, readNamespacedPodLog, controllers } = cluster([running], [ended])
    log.mockImplementation(async (_ns, _pod, _container, stream: Writable) => {
      const source = new PassThrough()
      source.pipe(stream)
      source.write('2026-11-14T08:00:00Z first\n')
      const controller = new AbortController()
      // as the client does: an abort errors the response it pipes in
      controller.signal.addEventListener('abort', () => source.destroy(new Error('aborted')))
      controllers.push(controller)
      return controller
    })
    readNamespacedPodLog.mockResolvedValue('2026-11-14T08:00:00Z first\n2026-11-14T08:00:09Z last\n')
    const lines: string[] = []
    const follower = followPodLogs(instance, 'ns', 'id=web', 'web', (line) => lines.push(line), {
      pollInterval: 1_000_000,
      followingInterval: 1_000_000,
    })
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      const settled = follower.settle()
      await vi.advanceTimersByTimeAsync(10_000)
      await settled
    } finally {
      vi.useRealTimers()
    }
    follower.stop()

    expect(controllers[0].signal.aborted).toBe(true)
    expect(lines).toEqual(['first', 'last'])
  })

  it('stops following when stopped', async () => {
    const { instance, controllers } = cluster([running])
    const follower = followPodLogs(instance, 'ns', 'id=web', 'web', () => undefined, { pollInterval: 1_000_000 })
    await follower.settle()
    follower.stop()

    expect(controllers).toHaveLength(1)
    expect(controllers[0].signal.aborted).toBe(true)
  })

  it('says once that a log could not be read', async () => {
    const { instance, listNamespacedPod } = cluster([running])
    listNamespacedPod.mockReset().mockRejectedValue(new Error('forbidden'))
    const errors: string[] = []
    const follower = followPodLogs(instance, 'ns', 'id=web', 'web', () => undefined, {
      pollInterval: 1_000_000,
      onError: (text) => errors.push(text),
    })
    await follower.settle()
    await follower.settle()
    follower.stop()

    expect(errors).toEqual(['the log of web could not be read: forbidden'])
  })

  it('holds at most a part of a line that does not end', async () => {
    const { instance, log } = cluster([running])
    log.mockImplementationOnce(async (_ns: string, _pod: string, _container: string, stream: Writable) => {
      for (let i = 0; i < 16; i++) {
        stream.write('x'.repeat(1024 * 1024))
      }
      stream.write('\nnext\n')
      return new AbortController()
    })
    const lines: string[] = []
    const follower = followPodLogs(instance, 'ns', 'id=web', 'web', (line) => lines.push(line), {
      pollInterval: 1_000_000,
    })
    await follower.settle()
    await tick()
    follower.stop()

    expect(lines).toEqual([`${'x'.repeat(MAX_LOG_LINE_CHARS)} … [cut at ${MAX_LOG_LINE_CHARS} characters]`, 'next'])
  })
})
