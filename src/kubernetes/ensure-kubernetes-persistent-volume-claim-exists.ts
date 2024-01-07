import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { V1PersistentVolumeClaim } from '@kubernetes/client-node'
import { apply, KubernetesObjectHeader } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getVersion } from '../version'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'
import { V1Volume } from '@kubernetes/client-node/dist/gen/model/v1Volume'
import { awaitPvcBound } from './await-running-state'

export async function ensureKubernetesPersistentVolumeClaimExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  volume: V1Volume,
  service: WorkItem<ContainerWorkService | ContainerWorkTask>
): Promise<V1PersistentVolumeClaim> {
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
      },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: env.storageClass,
      resources: {
        requests: {
          storage: '1Gi',
        },
      },
    },
  }
  service.status.console('stdout', `ensure volume ${volume.name}`)
  const result = await apply(instance, pvc)
  if (result.status?.phase === 'Bound') {
    return result
  }
  return await awaitPvcBound(instance, env, volume.name)
}
