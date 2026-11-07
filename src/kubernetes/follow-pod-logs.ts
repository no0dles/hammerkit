import { PassThrough, Writable } from 'stream'
import { createInterface } from 'readline'
import { V1Pod } from '@kubernetes/client-node'
import { getErrorMessage } from '../log'
import { KubernetesInstance } from './kubernetes-instance'

// what is read of an instance of a container that already ended
const MAX_ENDED_LOG_BYTES = 1024 * 1024

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
  const following: AbortController[] = []
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
  const readEnded = async (pod: string, previous: boolean) => {
    const log = await instance.coreApi.readNamespacedPodLog({
      name: pod,
      namespace,
      container,
      previous,
      limitBytes: MAX_ENDED_LOG_BYTES,
    })
    for (const line of String(log ?? '').split(/\r?\n/)) {
      if (line.length > 0) {
        onLine(line)
      }
    }
  }
  const follow = async (pod: string) => {
    const output = new PassThrough()
    let ended = false
    // the instance ended or the request broke: a restarted one is looked for at once
    const end = () => {
      if (!ended) {
        ended = true
        streaming--
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
    createInterface({ input: output }).on('line', (line) => onLine(line))
    streaming++
    let controller: AbortController
    try {
      controller = await instance.log.log(namespace, pod, container, output as Writable, { follow: true })
    } catch (e) {
      end()
      throw e
    }
    if (stopped) {
      controller.abort()
    } else {
      following.push(controller)
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
    if (last && !seen.has(last)) {
      seen.add(last)
      before = readEnded(name, true).catch(fail)
      track(before)
    }
    const current = status.containerID
    if (!current || seen.has(current)) {
      return
    }
    if (status.state?.running) {
      seen.add(current)
      track(before.then(() => follow(name)))
    } else if (status.state?.terminated) {
      seen.add(current)
      track(before.then(() => readEnded(name, false)))
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
      // what follows a running instance never ends by itself
      const ended = [...reading]
      let wait: NodeJS.Timeout | undefined
      await Promise.race([
        Promise.all(ended),
        new Promise<void>((resolve) => {
          wait = setTimeout(resolve, 5_000)
          wait.unref?.()
        }),
      ])
      clearTimeout(wait)
    },
    stop() {
      stopped = true
      clearTimeout(timer)
      for (const controller of following.splice(0)) {
        controller.abort()
      }
    },
  }
}
