import { createHash } from 'crypto'
import { V1PersistentVolumeClaim } from '@kubernetes/client-node'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { WorkTask } from '../planner/work-task'
import { KubernetesInstance } from './kubernetes-instance'
import { statusCodeOf } from './apply'
import { sleep } from '../utils/sleep'
import { getRunLabelValue } from './job-placement'

// On a server with `backend.keepVolumes`, the claim of a task stays after the run, so the
// next run of the same source finds the outputs in it and mounts them without restoring
// them from the cache. A kept claim has no run label (the end of the run removes what has
// one), but these:

// the trust of the source of the runs that may mount it (see getVolumeScope)
export const VOLUME_SCOPE_LABEL = 'hammerkit.dev/volume-scope'
// the run label of the run that mounted it last; while it runs, the claim does not expire
export const KEPT_BY_LABEL = 'hammerkit.dev/kept-by'
// the state key of the outputs in it, set once the task completed or they were restored
export const STATE_ANNOTATION = 'hammerkit.dev/state'
// when it goes, set by the end of the run that mounted it last
export const EXPIRES_ANNOTATION = 'hammerkit.dev/expires'

// The claim of a work item: a task's on a server that keeps them carries the scope, so a
// run of another source never mounts it. 63 characters at most, a pod's volume name.
export function getClaimName(
  work: WorkItem<WorkService | WorkTask>,
  kubernetes?: Pick<WorkKubernetesEnvironment, 'server'>
) {
  const scope = kubernetes?.server?.volumeScope
  const name = 'hammerkit-' + work.id()
  return scope && isTask(work) ? `${name}-${createHash('sha256').update(scope).digest('hex').slice(0, 12)}` : name
}

// whether the claim of the work item stays after the run
export function isKeptClaim(
  work: WorkItem<WorkService | WorkTask>,
  kubernetes: Pick<WorkKubernetesEnvironment, 'server'>
) {
  return !!kubernetes.server?.volumeScope && isTask(work)
}

function isTask(work: WorkItem<WorkService | WorkTask>): boolean {
  return work.data.type === 'container-task'
}

async function readClaim(
  instance: KubernetesInstance,
  namespace: string,
  name: string
): Promise<V1PersistentVolumeClaim | null> {
  try {
    return await instance.coreApi.readNamespacedPersistentVolumeClaim({ name, namespace })
  } catch (e) {
    if (statusCodeOf(e) === 404) {
      return null
    }
    throw e
  }
}

// The state key of the outputs a kept claim holds, null when it holds none that are whole.
// The claim is the run's from now: it does not expire or make way for another claim
// before the run ended, so outputs the run found in it are still there when it mounts them.
export async function useClaimState(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  name: string
): Promise<string | null> {
  let claim: V1PersistentVolumeClaim
  try {
    claim = await instance.objectApi.patch<V1PersistentVolumeClaim>({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: {
        name,
        namespace: kubernetes.namespace,
        labels: { [KEPT_BY_LABEL]: getRunLabelValue(kubernetes.server?.run ?? '') },
        // null removes it
        annotations: { [EXPIRES_ANNOTATION]: null as unknown as string },
      },
    })
  } catch (e) {
    if (statusCodeOf(e) === 404) {
      return null
    }
    throw e
  }
  // one being removed holds nothing to mount, nor one of another source (ensured anyway
  // by the hash of the source in its name)
  if (
    claim.metadata?.deletionTimestamp ||
    claim.metadata?.labels?.[VOLUME_SCOPE_LABEL] !== kubernetes.server?.volumeScope
  ) {
    return null
  }
  return claim.metadata?.annotations?.[STATE_ANNOTATION] ?? null
}

async function annotate(
  instance: KubernetesInstance,
  namespace: string,
  name: string,
  annotations: { [key: string]: string | null }
): Promise<boolean> {
  try {
    await instance.objectApi.patch({
      apiVersion: 'v1',
      kind: 'PersistentVolumeClaim',
      metadata: { name, namespace, annotations: annotations as { [key: string]: string } },
    })
    return true
  } catch (e) {
    if (statusCodeOf(e) === 404) {
      return false
    }
    throw e
  }
}

// Before a task writes to its kept claim: the outputs in it stop being those of a state.
// Whether the claim was there, with what an earlier run left in it.
export function forgetClaimState(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  name: string
): Promise<boolean> {
  return annotate(instance, kubernetes.namespace, name, { [STATE_ANNOTATION]: null })
}

// Once the outputs of `stateKey` are whole in the kept claim
export async function recordClaimState(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  name: string,
  stateKey: string
): Promise<void> {
  await annotate(instance, kubernetes.namespace, name, { [STATE_ANNOTATION]: stateKey })
}

// The kept claims in a namespace
async function listKeptClaims(
  instance: KubernetesInstance,
  namespace: string,
  labelSelector = VOLUME_SCOPE_LABEL
): Promise<V1PersistentVolumeClaim[]> {
  const claims = await instance.coreApi.listNamespacedPersistentVolumeClaim({ namespace, labelSelector })
  return claims.items.filter((claim) => !claim.metadata?.deletionTimestamp)
}

async function removeClaims(
  instance: KubernetesInstance,
  namespace: string,
  claims: V1PersistentVolumeClaim[],
  timeout: number
): Promise<string[]> {
  const names: string[] = []
  for (const claim of claims) {
    const name = claim.metadata?.name
    if (!name) {
      continue
    }
    try {
      // only as it was listed: one a run took for itself since (useClaimState) stays
      await instance.coreApi.deleteNamespacedPersistentVolumeClaim({
        name,
        namespace,
        body: { preconditions: { resourceVersion: claim.metadata?.resourceVersion } },
      })
      names.push(name)
    } catch (e) {
      if (statusCodeOf(e) === 404) {
        names.push(name)
      } else if (statusCodeOf(e) !== 409) {
        throw e
      }
    }
  }
  // a run mounts a claim of the same name again
  const deadline = Date.now() + timeout
  for (const name of names) {
    while (await readClaim(instance, namespace, name)) {
      if (Date.now() > deadline) {
        throw new Error(`the claim ${name} is still there after ${Math.round(timeout / 1000)}s`)
      }
      await sleep(1000)
    }
  }
  return names
}

// At the end of a run: the claims it kept go `keep` milliseconds from now, unless a run
// mounts them before
export async function expireKeptClaims(
  instance: KubernetesInstance,
  namespace: string,
  runLabel: string,
  expires: Date
): Promise<void> {
  for (const claim of await listKeptClaims(instance, namespace, `${KEPT_BY_LABEL}=${runLabel}`)) {
    if (claim.metadata?.name) {
      await annotate(instance, namespace, claim.metadata.name, { [EXPIRES_ANNOTATION]: expires.toISOString() })
    }
  }
}

// While no run of the caller is in the namespace: the kept claims that expired, and those
// a run left without an expiry because the server stopped before its end (all of them
// when the server keeps none any more). The names of those removed, and when the next of
// the others expires.
export async function sweepKeptClaims(
  instance: KubernetesInstance,
  namespace: string,
  options: { now: Date; keep: boolean; timeout: number }
): Promise<{ removed: string[]; next: Date | null }> {
  const expired: V1PersistentVolumeClaim[] = []
  let next: number | null = null
  for (const claim of await listKeptClaims(instance, namespace)) {
    const expires = Date.parse(claim.metadata?.annotations?.[EXPIRES_ANNOTATION] ?? '')
    if (!options.keep || !(expires > options.now.getTime())) {
      expired.push(claim)
    } else if (next === null || expires < next) {
      next = expires
    }
  }
  const removed = await removeClaims(instance, namespace, expired, options.timeout)
  return { removed, next: next === null ? null : new Date(next) }
}

// When a run needs room under the quota of its namespace: the kept claims it does not use
// go, those of the other sources and those of its own a task of this run did not take (one
// renamed or changed since). The names of those removed.
export async function evictKeptClaims(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  timeout: number
): Promise<string[]> {
  const server = kubernetes.server
  if (!server?.volumeScope) {
    return []
  }
  const unused = await listKeptClaims(
    instance,
    kubernetes.namespace,
    `${VOLUME_SCOPE_LABEL},${KEPT_BY_LABEL}!=${getRunLabelValue(server.run)}`
  )
  return removeClaims(instance, kubernetes.namespace, unused, timeout)
}
