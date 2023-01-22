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

export async function deployKubernetes(
  workTree: WorkTree,
  env: BuildFileEnvironment,
  options?: Partial<CliDeployOptions>
): Promise<SchedulerResult> {
  for (const service of iterateWorkServices(workTree.services)) {
    try {
      if (isContainerWorkService(service)) {
        await ensureKubernetesServiceExists(env, service)

        const volumes = getServiceVolumes(service)
        for (const volume of volumes) {
          await ensureKubernetesPersistentVolumeClaimExists(env, service, volume.name)
        }

        await ensurePersistentData(env, service, volumes)

        if (isContainerWorkService(service)) {
          // TODO remove if failed? already exists
          await ensureKubernetesDeploymentExists(env, service, volumes)
        }

        for (const ingress of env.ingresses) {
          if (ingress.service === service.name) {
            await ensureIngress(env, ingress, service)
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
