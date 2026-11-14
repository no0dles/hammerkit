import { PassThrough, Writable } from 'stream'
import { createInterface } from 'readline'
import { V1Pod } from '@kubernetes/client-node'
import { getErrorMessage } from '../log'
import { KubernetesInstance } from './kubernetes-instance'

// what is read of an instance of a container that already ended
const MAX_ENDED_LOG_BYTES = 1024 * 1024
// how often in a row the log of one instance is read again after its reading broke off at once
const MAX_READS = 20

// `timestamps: true` puts the time a line was written before it (RFC3339 with up to nine
// digits of a second), which says where a log that broke off got to
const TIMESTAMPED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?Z(?: (.*))?$/

// Where the log of one instance got to: the time of the last line read, and how many lines
// were read with that very time. Lines at the same time are told apart by their order.
interface Position {
  // seconds and nanoseconds, padded so that two compare as strings
  at: string | null
  // the second of `at`, which the API takes as `sinceTime`
  since: string | null
  count: number
  reads: number
}

export interface PodLogFollower {
  // looks once more and waits for what it reads then: the last words of a container that
  // just ended
  settle(): Promise<void>
  // stops following
  stop(): void
}

export interface FollowPodLogsOptions {
  // how often the pods are looked at while none is followed (1s)
  pollInterval?: number
  // how often while one is: the end of its log says when it stops anyway (15s), so a service
  // that is up for hours costs the API server little
  followingInterval?: number
  // why a log could not be read, said once
  onError?: (text: string) => void
}

/**
 * Follows the log of a container in the pods of a selector, as `docker attach` does for a
 * service on Docker: the instance that runs as it writes, and an instance that ended before
 * it was seen (one that crashed and was restarted) once, from its start. Each instance is
 * read once, by its container id.
 */
export function followPodLogs(
  instance: KubernetesInstance,
  namespace: string,
  labelSelector: string,
  container: string,
  onLine: (line: string) => void,
  options: FollowPodLogsOptions = {}
): PodLogFollower {
  const seen = new Set<string>()
  const positions = new Map<string, Position>()
  // the logs followed now, resolved when they end
  const streams = new Map<string, Promise<void>>()
  const following = new Map<string, AbortController>()
  // the instances that ended, by the last look
  const ended = new Set<string>()
  const reading = new Set<Promise<void>>()
  let stopped = false
  let failed = false
  let timer: NodeJS.Timeout | undefined
  let polling: Promise<void> = Promise.resolve()
  let busy = false
  let again = false
  // the logs followed now, which end when their instance does
  let streaming = 0

  const fail = (e: unknown) => {
    if (!failed && !stopped) {
      failed = true
      options.onError?.(`the log of ${container} could not be read: ${getErrorMessage(e)}`)
    }
  }
  const track = (promise: Promise<void>) => {
    const tracked = promise.catch(fail).finally(() => reading.delete(tracked))
    reading.add(tracked)
  }
  const positionOf = (id: string): Position => {
    let position = positions.get(id)
    if (!position) {
      position = { at: null, since: null, count: 0, reads: 0 }
      positions.set(id, position)
    }
    return position
  }
  // a reader of the log of one instance from where it got to: the lines read before, again
  // at the start of a log read since their second, are passed over
  const reader = (position: Position) => {
    const from = position.at
    const skip = position.count
    let atFrom = 0
    return (raw: string) => {
      const match = TIMESTAMPED.exec(raw)
      if (!match) {
        onLine(raw)
        return
      }
      const at = `${match[1]}.${(match[2] ?? '').padEnd(9, '0')}`
      if (from !== null && at <= from) {
        if (at < from || ++atFrom <= skip) {
          return
        }
      }
      if (at === position.at) {
        position.count++
      } else {
        position.at = at
        position.since = `${match[1]}Z`
        position.count = 1
      }
      onLine(match[3] ?? '')
    }
  }
  const readEnded = async (pod: string, id: string, previous: boolean) => {
    const position = positionOf(id)
    position.reads++
    const log = await instance.coreApi.readNamespacedPodLog({
      name: pod,
      namespace,
      container,
      previous,
      timestamps: true,
      limitBytes: MAX_ENDED_LOG_BYTES,
      // this call takes no sinceTime: a minute more than since then, for clocks that differ
      ...(position.since
        ? { sinceSeconds: Math.max(1, Math.ceil((Date.now() - Date.parse(position.since)) / 1000) + 60) }
        : {}),
    })
    const read = reader(position)
    for (const line of String(log ?? '').split(/\r?\n/)) {
      if (line.length > 0) {
        read(line)
      }
    }
  }
  const follow = async (pod: string, id: string) => {
    const position = positionOf(id)
    position.reads++
    const output = new PassThrough()
    const started = Date.now()
    let over = false
    let done: () => void = () => undefined
    const stream = new Promise<void>((resolve) => (done = resolve))
    streams.set(id, stream)
    // the instance ended or the request broke: it is looked at again at once, a restarted
    // one followed, and what this one wrote after the break read from where it got to
    const end = () => {
      if (!over) {
        over = true
        streaming--
        // a follow that lasted is cut now and then (a quiet stretch, a proxy): only reads
        // that break off at once count against the limit
        if (Date.now() - started >= 10_000) {
          position.reads = 0
        }
        streams.delete(id)
        following.delete(id)
        done()
        if (!stopped && position.reads < MAX_READS) {
          seen.delete(id)
        }
        wake()
      }
    }
    // stop() aborts the request, which errors the stream the client pipes in here
    output.on('pipe', (source) =>
      source.on('error', () => {
        end()
      })
    )
    output.on('end', end)
    createInterface({ input: output }).on('line', reader(position))
    streaming++
    let controller: AbortController
    try {
      controller = await instance.log.log(namespace, pod, container, output as Writable, {
        follow: true,
        timestamps: true,
        ...(position.since ? { sinceTime: position.since } : {}),
      })
    } catch (e) {
      end()
      throw e
    }
    if (stopped) {
      controller.abort()
    } else {
      following.set(id, controller)
    }
  }
  const look = (pod: V1Pod) => {
    const name = pod.metadata?.name
    const status = pod.status?.containerStatuses?.find((s) => s.name === container)
    // a pod that goes is of a Deployment before this one, or of a rollout that replaced it
    if (!name || !status || pod.metadata?.deletionTimestamp) {
      return
    }
    // an instance that ended before this one, not seen while it ran: its lines go first
    let before: Promise<void> = Promise.resolve()
    const last = status.lastState?.terminated?.containerID
    const current = status.containerID
    if (last) {
      ended.add(last)
    }
    if (current && status.state?.terminated) {
      ended.add(current)
    }
    if (last && !seen.has(last)) {
      seen.add(last)
      before = readEnded(name, last, true).catch(fail)
      track(before)
    }
    if (!current || seen.has(current)) {
      return
    }
    if (status.state?.running) {
      seen.add(current)
      track(before.then(() => follow(name, current)))
    } else if (status.state?.terminated) {
      seen.add(current)
      track(before.then(() => readEnded(name, current, false)))
    }
  }
  const poll = async () => {
    try {
      const pods = await instance.coreApi.listNamespacedPod({ namespace, labelSelector })
      if (!stopped) {
        pods.items.forEach(look)
      }
    } catch (e) {
      fail(e)
    }
  }
  const loop = () => {
    if (stopped) {
      return
    }
    busy = true
    polling = poll().finally(() => {
      busy = false
      if (stopped) {
        return
      }
      if (again) {
        again = false
        loop()
        return
      }
      const interval = streaming > 0 ? options.followingInterval ?? 15_000 : options.pollInterval ?? 1000
      timer = setTimeout(loop, interval)
      timer.unref?.()
    })
  }
  // looks now, not at the next interval
  function wake() {
    if (stopped) {
      return
    }
    if (busy) {
      again = true
      return
    }
    clearTimeout(timer)
    loop()
  }
  loop()

  return {
    async settle() {
      await polling
      await poll()
      // what follows an instance that ended ends by itself once it has read all there is
      const endedStreams = () => [...streams].filter(([id]) => ended.has(id))
      await within(Promise.all([...reading, ...endedStreams().map(([, stream]) => stream)]), 5_000)
      // one still going after that is cut, and read from where it got to
      const cut = endedStreams()
      if (cut.length > 0) {
        for (const [id] of cut) {
          following.get(id)?.abort()
        }
        await within(Promise.all(cut.map(([, stream]) => stream)), 1_000)
        await poll()
        await within(Promise.all([...reading]), 5_000)
      }
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      for (const controller of following.values()) {
        controller.abort()
      }
      following.clear()
    },
  }
}

async function within(promise: Promise<unknown>, ms: number): Promise<void> {
  let wait: NodeJS.Timeout | undefined
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      wait = setTimeout(resolve, ms)
      wait.unref?.()
    }),
  ])
  clearTimeout(wait)
}
