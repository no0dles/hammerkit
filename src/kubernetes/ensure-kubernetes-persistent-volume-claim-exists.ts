import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { V1PersistentVolumeClaim, V1Volume } from '@kubernetes/client-node'
import { KubernetesObjectHeader, statusCodeOf } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getVersion } from '../version'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'
import { getRunLabels } from './job-placement'
import { getErrorMessage } from '../log'
import { formatSize, parseSize } from '../utils/units'

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
// never shrinks.
export async function ensureKubernetesPersistentVolumeClaimExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  volume: V1Volume,
  service: WorkItem<ContainerWorkService | ContainerWorkTask>,
  size?: string | null
): Promise<V1PersistentVolumeClaim> {
  const storage = getClaimSize(env, size, service.name)
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
        ...getRunLabels(env),
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
  const existing = await readClaim(instance, pvc)
  if (!existing) {
    try {
      return await instance.objectApi.create(pvc)
    } catch (e) {
      // Two work items can make the same claim concurrently (e.g. a volume
      // shared between a task and a service that inherits its generates)
      if (statusCodeOf(e) !== 409) {
        throw e
      }
      return await instance.objectApi.read<V1PersistentVolumeClaim>(pvc)
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
