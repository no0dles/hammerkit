import { WorkEnvironment } from '../planner/work-environment'
import { WorkService } from '../planner/work-service'
import { V1PersistentVolumeClaim } from '@kubernetes/client-node'
import { apply } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getVersion } from '../version'

export async function ensureKubernetesPersistentVolumeClaimExists(
  instance: KubernetesInstance,
  env: WorkEnvironment,
  service: WorkService,
  name: string
): Promise<V1PersistentVolumeClaim> {
  const pvc: V1PersistentVolumeClaim = {
    kind: 'PersistentVolumeClaim',
    apiVersion: 'v1',
    metadata: {
      namespace: env.namespace,
      name,
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
    },
    spec: {
      accessModes: ['ReadWriteOnce'],
      storageClassName: 'local-path',
      resources: {
        requests: {
          storage: '1Gi',
        },
      },
    },
  }
  return await apply(
    instance,
    {
      kind: 'PersistentVolumeClaim',
      apiVersion: 'v1',
      metadata: {
        namespace: env.namespace,
        name,
      },
    },
    pvc
  )
}
