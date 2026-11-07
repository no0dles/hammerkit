import { CoreV1Event, V1ContainerStatus, V1Pod } from '@kubernetes/client-node'
import { getErrorMessage } from '../log'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkTree } from '../planner/work-tree'
import { statusCodeOf } from './apply'
import { getRunLabels } from './job-placement'
import { KubernetesInstance } from './kubernetes-instance'
import { NETWORK_GATE_CONTAINER } from './network-gate'
import { getItemKey } from './resources'

// what a pod's or event's message is cut to
const MAX_MESSAGE = 500
// how many events of a run are said, the newest
const MAX_EVENTS = 20
// events the result of a task says better: a Job of a failed command
const SAID_ELSEWHERE = ['BackoffLimitExceeded']

// A container restarted this often in a row is taken as one that keeps crashing: once may be
// a race with a dependency or a slow first start
export const CRASHES_TO_FAIL = 2
// what a pull error says when the image is not there to pull, or not for this cluster:
// waiting does not change it. Others (a registry that limits, a token not there yet) may pass.
const IMAGE_GONE = /not found|manifest unknown|unauthorized|denied|forbidden|invalid reference|no such host/i

export interface PodFailure {
  // why, as the cluster says it
  text: string
  // true: it won't change by waiting; false: it may still pass, it fails once it lasted
  final: boolean
}

/**
 * Why a pod of a service will not become ready without a change, as the cluster says it:
 * an image that can not be pulled, a container that keeps crashing or can not be created,
 * an init container that failed. Null while it may still get there.
 *
 * Only what the cluster wrote is quoted: the termination message of a container is its
 * own output (and may hold a value it read), except for the network gate's, which says why
 * the policy did not take hold.
 */
export function getPodFailure(pod: V1Pod, container?: string): PodFailure | null {
  for (const status of pod.status?.initContainerStatuses ?? []) {
    const terminated = status.state?.terminated ?? status.lastState?.terminated
    if (!terminated || terminated.exitCode === 0) {
      continue
    }
    if (status.name === NETWORK_GATE_CONTAINER) {
      return {
        text: `the network policy did not take hold: ${cut(terminated.message?.trim() || 'the gate failed')}`,
        final: true,
      }
    }
    if (status.restartCount >= CRASHES_TO_FAIL) {
      return { text: `its init container ${status.name} failed with exit code ${terminated.exitCode}`, final: true }
    }
  }
  for (const status of mainStatuses(pod, container)) {
    const failure = getContainerFailure(status)
    if (failure) {
      return failure
    }
  }
  return null
}

function getContainerFailure(status: V1ContainerStatus): PodFailure | null {
  const waiting = status.state?.waiting
  const reason = waiting?.reason
  const said = waiting?.message ? `: ${cut(waiting.message)}` : ''
  switch (reason) {
    // the first pull: final only when the registry said the image is not there, as older
    // kubelets leave that out of the ImagePullBackOff that follows
    case 'ErrImagePull':
      return IMAGE_GONE.test(waiting?.message ?? '')
        ? { text: `its image ${status.image} could not be pulled (${reason})${said}`, final: true }
        : null
    case 'ImagePullBackOff':
      return {
        text: `its image ${status.image} could not be pulled (${reason})${said}`,
        final: IMAGE_GONE.test(waiting?.message ?? ''),
      }
    case 'ErrImageNeverPull':
    case 'InvalidImageName':
      return { text: `its image ${status.image} could not be pulled (${reason})${said}`, final: true }
    case 'CreateContainerConfigError':
    case 'CreateContainerError':
    case 'RunContainerError':
      return { text: `its container could not be started (${reason})${said}`, final: false }
    case 'CrashLoopBackOff':
      return status.restartCount >= CRASHES_TO_FAIL
        ? { text: `it keeps crashing: ${describeLastExit(status)}`, final: true }
        : null
  }
  return null
}

// How the last instance of a container ended, as the cluster says it.
export function describeLastExit(status: V1ContainerStatus): string {
  const last = status.lastState?.terminated ?? status.state?.terminated
  const restarts = `, restarted ${status.restartCount} time${status.restartCount === 1 ? '' : 's'}`
  if (!last) {
    return `it ended${restarts}`
  }
  if (last.reason === 'OOMKilled') {
    return `it was killed for using more memory than its limit (OOMKilled)${restarts}`
  }
  // the kubelet kills a container whose liveness probe (its healthcheck) keeps failing
  const killed = last.exitCode === 137 || last.exitCode === 143 ? ', killed as when its healthcheck kept failing' : ''
  return `it exited with code ${last.exitCode}${last.reason ? ` (${last.reason})` : ''}${killed}${restarts}`
}

/**
 * What a pod of a service waits for, in a few words, while it is not ready: a node, its
 * image, its container. Undefined when it waits for nothing the cluster names.
 */
export function getPodWaiting(pod: V1Pod, container?: string): string | undefined {
  const scheduled = pod.status?.conditions?.find((condition) => condition.type === 'PodScheduled')
  if (scheduled?.status === 'False') {
    return `waits for a node: ${cut(scheduled.message ?? scheduled.reason ?? 'not scheduled yet')}`
  }
  for (const status of mainStatuses(pod, container)) {
    const waiting = status.state?.waiting
    const said = waiting?.message ? `: ${cut(waiting.message)}` : ''
    switch (waiting?.reason) {
      case 'ErrImagePull':
      case 'ImagePullBackOff':
        return `can not pull its image ${status.image} yet${said}`
      case 'CreateContainerConfigError':
      case 'CreateContainerError':
      case 'RunContainerError':
        return `can not start its container yet (${waiting.reason})${said}`
      case 'CrashLoopBackOff':
        return `crashed and starts again: ${describeLastExit(status)}`
    }
    if (status.restartCount > 0 && status.state?.running && !status.ready) {
      return `restarted: ${describeLastExit(status)}`
    }
  }
  return undefined
}

function mainStatuses(pod: V1Pod, container?: string): V1ContainerStatus[] {
  return (pod.status?.containerStatuses ?? []).filter((status) => !container || status.name === container)
}

// One line of a pod that is not as it should be, or null for one that runs, ready, or ended well.
export function describePod(pod: V1Pod): string | null {
  const name = pod.metadata?.name ?? '?'
  const phase = pod.status?.phase ?? 'Unknown'
  const failure = getPodFailure(pod)?.text
  const waiting = getPodWaiting(pod)
  const unready = (pod.status?.containerStatuses ?? [])
    .filter((status) => !status.ready && !status.state?.terminated)
    .map((status) => status.name)
  const crashed = (pod.status?.containerStatuses ?? []).filter(
    (status) => (status.state?.terminated && status.state.terminated.exitCode !== 0) || status.restartCount > 0
  )
  if (!failure && !waiting && crashed.length === 0 && (phase === 'Succeeded' || unready.length === 0)) {
    return null
  }
  const said = failure ?? waiting
  const parts = [phase, ...(said ? [said] : [])]
  for (const status of crashed) {
    if (!said?.includes(describeLastExit(status))) {
      parts.push(`${status.name}: ${describeLastExit(status)}`)
    }
  }
  if (!said && unready.length > 0) {
    parts.push(`not ready: ${unready.join(', ')}`)
  }
  return `pod ${name}: ${parts.join(', ')}`
}

/**
 * The message of a warning event, as far as it is the cluster's: a failed probe says the
 * output of the command, which is the service's, and is left out.
 */
export function describeEvent(event: CoreV1Event): string {
  const object = event.involvedObject
  const message = (event.message ?? '').replace(/^((Readiness|Liveness|Startup) probe (failed|errored)).*$/s, '$1')
  const count = (event.count ?? 1) > 1 ? ` (${event.count} times)` : ''
  return `${event.reason ?? 'Warning'} ${object.kind?.toLowerCase() ?? 'object'}/${object.name ?? '?'}: ${cut(
    message.trim()
  )}${count}`
}

/**
 * What the cluster said of a run that failed, into its log before the server removes its
 * objects: its pods that are not as they should be, and the warning events of its objects.
 * In the namespace of a service run everything is the run's; in a caller's namespace, which
 * runs share, only the objects of the run's items (named by their key) are.
 */
export async function readClusterState(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  workTree: WorkTree,
  ownNamespace: boolean
): Promise<string[]> {
  const namespace = kubernetes.namespace
  const keys = [...Object.values(workTree.tasks), ...Object.values(workTree.services)].map((item) =>
    getItemKey(item, kubernetes)
  )
  const ours = (name: string | undefined) => ownNamespace || keys.some((key) => name?.includes(key))
  const lines: string[] = []
  try {
    const labels = getRunLabels(kubernetes)
    const labelSelector = Object.entries(labels)
      .map(([key, value]) => `${key}=${value}`)
      .join(',')
    const pods = await instance.coreApi.listNamespacedPod({
      namespace,
      ...(labelSelector && !ownNamespace ? { labelSelector } : {}),
    })
    for (const pod of pods.items) {
      const line = ours(pod.metadata?.name) ? describePod(pod) : null
      if (line) {
        lines.push(line)
      }
    }
  } catch (e) {
    lines.push(`its pods could not be read: ${getErrorMessage(e)}`)
  }
  try {
    const events = await instance.coreApi.listNamespacedEvent({ namespace, fieldSelector: 'type=Warning' })
    const warnings = events.items
      .filter((event) => ours(event.involvedObject.name) && !SAID_ELSEWHERE.includes(event.reason ?? ''))
      .sort((a, b) => eventTime(a) - eventTime(b))
      .slice(-MAX_EVENTS)
    lines.push(...warnings.map((event) => `event ${describeEvent(event)}`))
  } catch (e) {
    lines.push(
      statusCodeOf(e) === 403
        ? `its events could not be read: the runRole of the server needs list on events (see the backend docs)`
        : `its events could not be read: ${getErrorMessage(e)}`
    )
  }
  return lines
}

function eventTime(event: CoreV1Event): number {
  const time = event.lastTimestamp ?? event.eventTime ?? event.firstTimestamp ?? event.metadata?.creationTimestamp
  return time ? new Date(time).getTime() : 0
}

function cut(text: string): string {
  const line = text.replace(/\s+/g, ' ')
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE)}…` : line
}
