import { WorkEnvironment } from '../planner/work-environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { getResourceName } from './resources'
import { KubernetesInstance } from './kubernetes-instance'

export async function getServiceIp(
  instance: KubernetesInstance,
  env: WorkEnvironment,
  workService: WorkItem<ContainerWorkService>
): Promise<string | null> {
  const name = getResourceName(workService)
  const svc = await instance.coreApi.readNamespacedService(name, env.namespace)

  return svc.body.spec?.clusterIP ?? null
}
