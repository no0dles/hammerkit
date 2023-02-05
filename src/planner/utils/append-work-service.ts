import { WorkTree } from '../work-tree'
import { ReferenceService } from '../../schema/reference-parser'
import { getWorkServiceId } from '../work-service-id'
import { BaseWorkService, ContainerWorkService, KubernetesWorkService, WorkService } from '../work-service'
import { parseWorkPorts } from './parse-work-ports'
import { templateValue } from './template-value'
import { isBuildFileKubernetesServiceSchema } from '../../schema/build-file-service-schema'
import { getDefaultKubeConfig } from './get-default-kube-config'
import { parseWorkCommand } from './parse-work-command'
import { parseWorkVolumes } from './parse-work-volume'
import { parseWorkMounts } from './parse-work-mounts'
import { parseWorkSource } from './parse-work-source'
import { appendWorkDependencies } from './append-work-dependencies'
import { appendWorkNeeds } from './append-work-needs'
import { Environment } from '../../executer/environment'
import { WorkItem } from '../work-item'

export function appendWorkService(
  workTree: WorkTree,
  service: ReferenceService,
  environment: Environment
): WorkItem<WorkService> {
  const workService = parseService(service)
  const id = getWorkServiceId(workService)
  if (!workTree.services[id]) {
    const workTreeService: WorkItem<WorkService> = {
      id,
      name: workService.name,
      data: workService,
      status: environment.status.from(id, workService),
      deps: [],
      needs: [],
    }
    workTree.services[id] = workTreeService
    appendWorkDependencies(workTree, service, workTreeService, environment)
    appendWorkNeeds(workTree, service, workTreeService, environment)
    return workTreeService
  } else {
    // TODO check for conflicts
    return workTree.services[id]
  }
}

function parseService(service: ReferenceService): WorkService {
  const workService: BaseWorkService = {
    name: service.relativeName,
    ports: parseWorkPorts(service.schema, service.envs),
    scope: service.scope,
    labels: service.labels,
    description: templateValue(service.schema.description || '', service.envs),
  }

  if (isBuildFileKubernetesServiceSchema(service.schema)) {
    return <KubernetesWorkService>{
      type: 'kubernetes-service',
      ...workService,
      kubeconfig: service.schema.kubeconfig ?? getDefaultKubeConfig(),
      selector: service.schema.selector,
      context: service.schema.context,
    }
  } else {
    return <ContainerWorkService>{
      ...workService,
      type: 'container-service',
      healthcheck: service.schema.healthcheck
        ? {
            cmd: parseWorkCommand(service.cwd, service.schema.healthcheck, service.envs),
          }
        : null,
      envs: service.envs,
      image: service.schema.image,
      cwd: service.cwd,
      cmd: service.schema.cmd ? parseWorkCommand(service.cwd, service.schema.cmd, service.envs) : null,
      volumes: parseWorkVolumes(service.cwd, service.schema.volumes),
      mounts: parseWorkMounts(service.cwd, service.schema, service.envs),
      src: parseWorkSource(service.cwd, service.schema.src, service.envs),
    }
  }
}
