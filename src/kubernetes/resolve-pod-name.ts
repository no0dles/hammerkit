import { AppsV1Api, CoreV1Api } from '@kubernetes/client-node'
import { WorkKubernetesSelector } from '../planner/work-kubernetes-selector'

function formatSelector(matchLabels: { [key: string]: string }): string {
  return Object.entries(matchLabels)
    .map(([k, v]) => `${k}=${v}`)
    .join(',')
}

async function findReadyPod(coreApi: CoreV1Api, namespace: string, labelSelector: string): Promise<string> {
  const pods = await coreApi.listNamespacedPod(
    namespace,
    undefined,
    undefined,
    undefined,
    undefined,
    labelSelector
  )
  const ready = pods.body.items.find((p) =>
    p.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
  )
  const pod = ready ?? pods.body.items[0]
  if (!pod?.metadata?.name) {
    throw new Error(`no pod found for selector ${labelSelector} in namespace ${namespace}`)
  }
  return pod.metadata.name
}

export async function resolvePodName(
  coreApi: CoreV1Api,
  appsApi: AppsV1Api,
  namespace: string,
  selector: WorkKubernetesSelector
): Promise<string> {
  const type = selector.type.toLowerCase()
  if (type === 'pod') {
    return selector.name
  }
  if (type === 'service') {
    const svc = await coreApi.readNamespacedService(selector.name, namespace)
    const matchLabels = svc.body.spec?.selector
    if (!matchLabels || Object.keys(matchLabels).length === 0) {
      throw new Error(`service ${selector.name} has no selector`)
    }
    return findReadyPod(coreApi, namespace, formatSelector(matchLabels))
  }
  if (type === 'deployment') {
    const deploy = await appsApi.readNamespacedDeployment(selector.name, namespace)
    const matchLabels = deploy.body.spec?.selector?.matchLabels
    if (!matchLabels) {
      throw new Error(`deployment ${selector.name} has no matchLabels`)
    }
    return findReadyPod(coreApi, namespace, formatSelector(matchLabels))
  }
  throw new Error(`unsupported selector type ${selector.type}`)
}
