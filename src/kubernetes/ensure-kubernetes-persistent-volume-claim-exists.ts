import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { V1ConfigMap, V1PersistentVolumeClaim } from '@kubernetes/client-node'
import { apply } from './apply'
import { KubernetesInstance } from './kubernetes-instance'
import { getVersion } from '../version'
import { KubernetesConfigMapPersistence, KubernetesVolumePersistence } from './volumes'
import { Environment } from '../executer/environment'

export async function ensureKubernetesConfigMap(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  environment: Environment,
  config: KubernetesConfigMapPersistence
) {
  const data: { [key: string]: string } = {}
  for (const source of config.sources) {
    const content = await environment.file.read(source.localPath)
    data[source.subPath] = content
  }
  const configMap: V1ConfigMap = {
    metadata: {
      name: config.name,
    },
    kind: 'ConfigMap',
    apiVersion: 'v1',
    data,
  }

  try {
    await apply(
      instance,
      {
        kind: 'ConfigMap',
        apiVersion: 'v1',
        metadata: {
          namespace: env.namespace,
          name: config.name,
        },
      },
      configMap
    )
  } catch (e) {
    throw e
  }
}

export async function ensureKubernetesPersistentVolumeClaimExists(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  volume: KubernetesVolumePersistence
): Promise<V1PersistentVolumeClaim> {
  const pvc: V1PersistentVolumeClaim = {
    kind: 'PersistentVolumeClaim',
    apiVersion: 'v1',
    metadata: {
      namespace: env.namespace,
      name: volume.volume.name,
      annotations: {
        'hammerkit.dev/version': getVersion(),
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
  return await apply(
    instance,
    {
      kind: 'PersistentVolumeClaim',
      apiVersion: 'v1',
      metadata: {
        namespace: env.namespace,
        name: volume.volume.name,
      },
    },
    pvc
  )
}
