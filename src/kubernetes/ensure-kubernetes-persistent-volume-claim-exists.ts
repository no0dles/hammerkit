import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { V1PersistentVolumeClaim, V1Volume } from '@kubernetes/client-node'
import { KubernetesObjectHeader, statusCodeOf } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getVersion } from '../version'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'
import { getRunLabels, getRunLabelValue } from './job-placement'
import { getErrorMessage } from '../log'
import { formatSize, parseSize } from '../utils/units'
import { sleep } from '../utils/sleep'
import { evictKeptClaims, EXPIRES_ANNOTATION, KEPT_BY_LABEL, VOLUME_SCOPE_LABEL } from './kept-claims'

// how long a claim that is being removed (a kept one that expired) gets to go before one
// of its name is made again, and the kept claims of other sources when the quota is full
const REMOVAL_TIMEOUT = 60_000

// what the claim of a task or service requests when neither it nor the environment says
export const DEFAULT_VOLUME_SIZE = '1Gi'

// The size of a claim: the work's `volumeSize`, else the environment's, at most what the
// environment allows (a server's `maxVolumeSize`).
export function getClaimSize(env: WorkKubernetesEnvironment, size: string | null | undefined, name: string): string {
  const requested = size ?? env.volumeSize ?? DEFAULT_VOLUME_SIZE
  if (env.maxVolumeSize && parseSize(requested) > parseSize(env.maxVolumeSize)) {
    throw new Error(`${name} asks for a claim of ${requested}, the server allows at most ${env.maxVolumeSize}`)
  }
  return requested
}

// The size a claim requests, in bytes, as the cluster may write it back (`1Gi`, bytes)
function getRequestedBytes(claim: V1PersistentVolumeClaim): number | null {
  const storage = claim.spec?.resources?.requests?.storage
  try {
    return storage === undefined ? null : parseSize(String(storage))
  } catch {
    return null
  }
}

// The claim of a work item, of `size` (see getClaimSize). One a run before made smaller
// grows, where its storage class allows that; a larger one stays as it is, since a claim
// never shrinks. A `kept` claim (see kept-claims) carries the scope of the run instead of
// its label, and does not expire while the run mounts it.
export async function ensureKubernetesPersistentVolumeClaimExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  volume: V1Volume,
  service: WorkItem<ContainerWorkService | ContainerWorkTask>,
  size?: string | null,
  kept = false
): Promise<V1PersistentVolumeClaim> {
  const storage = getClaimSize(env, size, service.name)
  const scope = kept ? env.server?.volumeScope : undefined
  const runLabel = env.server ? getRunLabelValue(env.server.run) : undefined
  const pvc: V1PersistentVolumeClaim & KubernetesObjectHeader = {
    kind: 'PersistentVolumeClaim',
    apiVersion: 'v1',
    metadata: {
      namespace: env.namespace,
      name: volume.name,
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
      labels: {
        'hammerkit.dev/id': service.id(),
        ...(scope && runLabel ? { [VOLUME_SCOPE_LABEL]: scope, [KEPT_BY_LABEL]: runLabel } : getRunLabels(env)),
      },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: env.storageClass,
      resources: {
        requests: {
          storage,
        },
      },
    },
  }
  service.status.console('stdout', `ensure volume ${volume.name}`)
  // Don't block on the PVC reaching "Bound". Storage classes with
  // volumeBindingMode WaitForFirstConsumer (docker-desktop's "standard",
  // k3d/k3s local-path, most cloud defaults) keep the claim Pending until a pod
  // mounts it — and hammerkit creates that pod (upload pod / deployment) only
  // after this call. Waiting here deadlocks until the test times out. k8s binds
  // the claim when the consuming pod is scheduled, so applying it is enough.
  let existing = await readClaim(instance, pvc)
  if (existing?.metadata?.deletionTimestamp) {
    // a kept claim that expired: one of the same name is made once it is gone
    existing = await untilRemoved(instance, pvc)
  }
  if (!existing) {
    return await createClaim(instance, env, pvc)
  }
  if (scope) {
    if (existing.metadata?.labels?.[VOLUME_SCOPE_LABEL] !== scope) {
      throw new Error(`the claim ${volume.name} is not one this run may mount, it was made for another source`)
    }
    if (
      existing.metadata?.labels?.[KEPT_BY_LABEL] !== runLabel ||
      existing.metadata?.annotations?.[EXPIRES_ANNOTATION]
    ) {
      // mounted by this run now: it expires at the run's end
      existing = await instance.objectApi.patch<V1PersistentVolumeClaim>({
        apiVersion: pvc.apiVersion,
        kind: pvc.kind,
        metadata: {
          name: pvc.metadata.name,
          namespace: pvc.metadata.namespace,
          labels: { [KEPT_BY_LABEL]: runLabel as string },
          // null removes it
          annotations: { [EXPIRES_ANNOTATION]: null as unknown as string },
        },
      })
    }
  }
  const current = getRequestedBytes(existing)
  if (current === null || current >= parseSize(storage)) {
    return existing
  }
  try {
    // the requested size is all of a bound claim's spec that may change
    return await instance.objectApi.patch<V1PersistentVolumeClaim>({
      ...pvc,
      spec: { resources: { requests: { storage } } },
    })
  } catch (e) {
    throw new Error(
      `the claim ${volume.name} has ${formatSize(current)} and ${service.name} needs ${storage}, ` +
        `which its storage class could not grow it to (${getErrorMessage(e)}): ` +
        'remove it with hammerkit clean and run again'
    )
  }
}

async function createClaim(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  pvc: V1PersistentVolumeClaim & KubernetesObjectHeader
): Promise<V1PersistentVolumeClaim> {
  for (let evicted = false; ; evicted = true) {
    try {
      return await instance.objectApi.create(pvc)
    } catch (e) {
      // Two work items can make the same claim concurrently (e.g. a volume
      // shared between a task and a service that inherits its generates)
      if (statusCodeOf(e) === 409) {
        return await instance.objectApi.read<V1PersistentVolumeClaim>(pvc)
      }
      // the claims a server keeps for other sources make way under the quota
      if (evicted || statusCodeOf(e) !== 403 || !/exceeded quota/i.test(getErrorMessage(e))) {
        throw e
      }
      const removed = await evictKeptClaims(instance, env, REMOVAL_TIMEOUT)
      if (removed.length === 0) {
        throw e
      }
    }
  }
}

async function untilRemoved(
  instance: KubernetesInstance,
  pvc: V1PersistentVolumeClaim & KubernetesObjectHeader
): Promise<null> {
  const deadline = Date.now() + REMOVAL_TIMEOUT
  for (;;) {
    const claim = await readClaim(instance, pvc)
    if (!claim) {
      return null
    }
    if (Date.now() > deadline) {
      throw new Error(
        `the claim ${pvc.metadata.name} is being removed and still there after ${REMOVAL_TIMEOUT / 1000}s`
      )
    }
    await sleep(1000)
  }
}

async function readClaim(
  instance: KubernetesInstance,
  pvc: V1PersistentVolumeClaim & KubernetesObjectHeader
): Promise<V1PersistentVolumeClaim | null> {
  try {
    return await instance.objectApi.read<V1PersistentVolumeClaim>(pvc)
  } catch (e) {
    if (statusCodeOf(e) === 404) {
      return null
    }
    throw e
  }
}
