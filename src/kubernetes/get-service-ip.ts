import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { getResourceName } from './resources'
import { KubernetesInstance } from './kubernetes-instance'

// The address a task reaches the service on: its clusterIP, or for a headless
// Service (a service without ports) the address of its ready pod.
export async function getServiceIp(
  instance: KubernetesInstance,
  env: WorkKubernetesEnvironment,
  workService: WorkItem<ContainerWorkService>
): Promise<string | null> {
  const name = getResourceName(workService)
  const svc = await instance.coreApi.readNamespacedService({ name, namespace: env.namespace })
  const clusterIP = svc.spec?.clusterIP ?? null
  if (clusterIP !== 'None') {
    return clusterIP
  }

  const pods = await instance.coreApi.listNamespacedPod({
    namespace: env.namespace,
    labelSelector: `hammerkit.dev/id=${workService.id()}`,
  })
  const ready = pods.items.find(
    (pod) =>
      !pod.metadata?.deletionTimestamp &&
      pod.status?.podIP &&
      pod.status.conditions?.some((c) => c.type === 'Ready' && c.status === 'True')
  )
  const running = ready ?? pods.items.find((pod) => !pod.metadata?.deletionTimestamp && pod.status?.podIP)
  return running?.status?.podIP ?? null
}
