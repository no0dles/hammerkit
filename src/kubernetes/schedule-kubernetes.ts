import { getServiceVolumes } from './volumes'
import { ensureKubernetesServiceExists } from './ensure-kubernetes-service-exists'
import { ensureKubernetesDeploymentExists } from './ensure-kubernetes-deployment-exists'
import { ensureIngress } from './ensure-ingress'
import { ensurePersistentData } from './ensure-persistent-data'
import { ensureKubernetesPersistentVolumeClaimExists } from './ensure-kubernetes-persistent-volume-claim-exists'
import { WorkTree } from '../planner/work-tree'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { iterateWorkServices } from '../planner/utils/plan-work-tasks'
import { isContainerWorkService } from '../planner/work-service'
import { isContainerWorkServiceItem } from '../planner/work-item'
import { WorkEnvironment } from '../planner/work-environment'
import { KubernetesInstance } from './kubernetes-instance'

export async function deployKubernetes(
  instance: KubernetesInstance,
  workTree: WorkTree,
  env: WorkEnvironment
): Promise<SchedulerResult> {
  for (const item of iterateWorkServices(workTree)) {
    if (isContainerWorkServiceItem(item)) {
      await ensureKubernetesServiceExists(instance, env, item)

      const volumes = getServiceVolumes(item)
      for (const volume of volumes) {
        await ensureKubernetesPersistentVolumeClaimExists(instance, env, item.data, volume.name)
      }

      await ensurePersistentData(instance, env, item, volumes)

      if (isContainerWorkService(item.data)) {
        // TODO remove if failed? already exists
        await ensureKubernetesDeploymentExists(instance, env, item, volumes)
      }

      for (const ingress of env.ingresses) {
        if (ingress.service === item.data.name) {
          await ensureIngress(instance, env, ingress, item)
        }
      }
    }
  }

  return {
    success: true,
    state: workTree,
  }
}
