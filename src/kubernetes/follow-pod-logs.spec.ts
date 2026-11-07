import { Writable } from 'stream'
import { followPodLogs } from './follow-pod-logs'
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
    expect(log).toHaveBeenCalledWith('ns', 'web-1', 'web', expect.anything(), { follow: true })
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
    await follower.settle()
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
})
