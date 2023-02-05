import { WorkTree } from '../../planner/work-tree'
import { iterateWorkServices } from '../../planner/utils/plan-work-nodes'
import { SchedulerResult } from '../scheduler/scheduler-result'
import { CliDeployOptions } from '../../cli'
import { isContainerWorkService } from '../../planner/work-service'
import {
  ensureIngress,
  ensureKubernetesDeploymentExists,
  ensureKubernetesPersistentVolumeClaimExists,
  ensureKubernetesServiceExists,
  ensurePersistentData,
} from './resources'
import { getServiceVolumes } from './volumes'
import { BuildFileEnvironment } from '../../parser/build-file-environment'
import { isContainerWorkServiceItem } from '../../planner/work-item'

export async function deployKubernetes(
  workTree: WorkTree,
  env: BuildFileEnvironment,
  options?: Partial<CliDeployOptions>
): Promise<SchedulerResult> {
  for (const item of iterateWorkServices(workTree.services)) {
    try {
      if (isContainerWorkServiceItem(item)) {
        await ensureKubernetesServiceExists(env, item)

        const volumes = getServiceVolumes(item)
        for (const volume of volumes) {
          await ensureKubernetesPersistentVolumeClaimExists(env, item.data, volume.name)
        }

        await ensurePersistentData(env, item, volumes)

        if (isContainerWorkService(item.data)) {
          // TODO remove if failed? already exists
          await ensureKubernetesDeploymentExists(env, item, volumes)
        }

        for (const ingress of env.ingresses) {
          if (ingress.service === item.data.name) {
            await ensureIngress(env, ingress, item)
          }
        }
      }

      // console.log(res)
    } catch (e) {
      console.log(e)
    }
  }

  return {
    success: true,
    state: {
      daemon: true,
      service: {},
      node: {},
      watch: false,
      cacheMethod: 'none',
    },
  }
}
