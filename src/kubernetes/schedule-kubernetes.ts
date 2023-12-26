import { WorkTree } from '../planner/work-tree'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { WorkKubernetesEnvironment } from '../planner/work-environment'
import { KubernetesInstance } from './kubernetes-instance'

export async function deployKubernetes(
  instance: KubernetesInstance,
  workTree: WorkTree,
  env: WorkKubernetesEnvironment
): Promise<SchedulerResult> {
  // for (const item of iterateWorkServices(workTree)) {
  //   if (isContainerWorkServiceItem(item)) {
  //     await ensureKubernetesServiceExists(instance, env, item)
  //
  //     const volumes = getServiceVolumes(item)
  //     for (const volume of volumes) {
  //       await ensureKubernetesPersistentVolumeClaimExists(instance, env, item.data, volume.name)
  //     }
  //
  //     await ensurePersistentData(instance, env, item)
  //
  //     if (isContainerWorkService(item.data)) {
  //       // TODO remove if failed? already exists
  //       await ensureKubernetesDeploymentExists(instance, env, item, volumes)
  //     }
  //
  //     for (const ingress of env.ingresses) {
  //       if (ingress.service === item.data.name) {
  //         await ensureIngress(instance, env, ingress, item)
  //       }
  //     }
  //   }
  // }

  return {
    success: true,
    state: workTree,
  }
}
