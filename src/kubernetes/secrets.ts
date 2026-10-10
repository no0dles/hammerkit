import { V1EnvVar, V1Secret, V1Volume, V1VolumeMount } from '@kubernetes/client-node'
import { KubernetesInstance } from './kubernetes-instance'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'
import { WorkSecret, resolveSecretValue } from '../planner/work-secret'
import { Environment } from '../executer/environment'
import { apply, KubernetesObjectHeader, statusCodeOf } from './apply'
import { getResourceName } from './resources'
import { getVersion } from '../version'

const SECRET_VOLUME_NAME = 'hammerkit-secrets'

export interface KubernetesSecretRefs {
  env: V1EnvVar[]
  mounts: V1VolumeMount[]
  volumes: V1Volume[]
}

export function getSecretResourceName(item: WorkItem<ContainerWorkService | ContainerWorkTask>): string {
  return getResourceName(item, '-secrets')
}

// The values go into a Secret of the item; the pod only references it, so no
// value is part of a Job or Deployment spec.
export function getKubernetesSecretRefs(
  item: WorkItem<ContainerWorkService | ContainerWorkTask>,
  secrets: WorkSecret[]
): KubernetesSecretRefs {
  if (secrets.length === 0) {
    return { env: [], mounts: [], volumes: [] }
  }
  const secretName = getSecretResourceName(item)
  const refs: KubernetesSecretRefs = {
    env: [],
    mounts: [],
    volumes: [{ name: SECRET_VOLUME_NAME, secret: { secretName } }],
  }
  secrets.forEach((secret, index) => {
    const key = getSecretKey(index)
    if (secret.target.type === 'env') {
      refs.env.push({ name: secret.target.name, valueFrom: { secretKeyRef: { name: secretName, key } } })
      return
    }
    refs.mounts.push({ name: SECRET_VOLUME_NAME, mountPath: secret.target.path, subPath: key, readOnly: true })
  })
  if (refs.mounts.length === 0) {
    refs.volumes = []
  }
  return refs
}

export async function ensureKubernetesSecret(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  item: WorkItem<ContainerWorkService | ContainerWorkTask>,
  secrets: WorkSecret[],
  environment: Environment
): Promise<void> {
  if (secrets.length === 0) {
    return
  }
  const stringData: { [key: string]: string } = {}
  for (const [index, secret] of secrets.entries()) {
    stringData[getSecretKey(index)] = await resolveSecretValue(secret, environment)
  }
  const spec: V1Secret & KubernetesObjectHeader = {
    kind: 'Secret',
    apiVersion: 'v1',
    metadata: {
      namespace: kubernetes.namespace,
      name: getSecretResourceName(item),
      annotations: {
        'hammerkit.dev/version': getVersion(),
      },
      labels: {
        'hammerkit.dev/id': item.id(),
      },
    },
    type: 'Opaque',
    stringData,
  }
  await apply(instance, spec)
}

export async function removeKubernetesSecret(
  instance: KubernetesInstance,
  kubernetes: WorkKubernetesEnvironment,
  item: WorkItem<ContainerWorkService | ContainerWorkTask>
): Promise<void> {
  try {
    await instance.coreApi.deleteNamespacedSecret({
      name: getSecretResourceName(item),
      namespace: kubernetes.namespace,
    })
  } catch (e) {
    if (statusCodeOf(e) !== 404) {
      throw e
    }
  }
}

function getSecretKey(index: number): string {
  return `secret-${index}`
}
