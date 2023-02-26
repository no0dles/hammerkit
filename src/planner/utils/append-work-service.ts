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
import { createSource, parseWorkSource } from './parse-work-source'
import { appendWorkDependencies } from './append-work-dependencies'
import { appendWorkNeeds } from './append-work-needs'
import { Environment } from '../../executer/environment'
import { WorkItemState } from '../work-item'
import { buildEnvironmentVariables } from '../../environment/replace-env-variables'
import { ServiceState } from '../../executer/scheduler/service-state'
import { State } from '../../executer/state'

export function appendWorkService(
  workTree: WorkTree,
  service: ReferenceService,
  environment: Environment
): WorkItemState<WorkService, ServiceState> {
  const workService = parseService(service, environment)
  if (!workTree.services[workService.name]) {
    const workTreeService: WorkItemState<WorkService, ServiceState> = {
      id: () => getWorkServiceId(workService), // TODO lazy caching
      name: workService.name,
      data: workService,
      status: environment.status.from(workService),
      deps: [],
      needs: [],
      requiredBy: [],
      state: new State<ServiceState>({
        type: 'pending',
        stateKey: null,
      }),
    }
    workTree.services[workTreeService.name] = workTreeService
    appendWorkDependencies(workTree, service, workTreeService, environment)
    appendWorkNeeds(workTree, service, workTreeService, environment)
    return workTreeService
  } else {
    return workTree.services[workService.name]
  }
}

function parseService(service: ReferenceService, environment: Environment): WorkService {
  const envs = buildEnvironmentVariables(service.envs, environment)
  const workService: BaseWorkService = {
    cwd: service.cwd,
    name: service.relativeName,
    ports: parseWorkPorts(service.schema, envs),
    scope: service.scope,
    labels: service.labels,
    description: templateValue(service.schema.description || '', envs),
  }

  if (isBuildFileKubernetesServiceSchema(service.schema)) {
    const kubeconfig = service.schema.kubeconfig ?? getDefaultKubeConfig()
    return <KubernetesWorkService>{
      type: 'kubernetes-service',
      ...workService,
      kubeconfig,
      selector: {
        name: templateValue(service.schema.selector.name, envs),
        type: templateValue(service.schema.selector.type, envs),
      },
      context: templateValue(service.schema.context, envs),
      src: [createSource(kubeconfig)],
    }
  } else {
    return <ContainerWorkService>{
      ...workService,
      type: 'container-service',
      healthcheck: service.schema.healthcheck
        ? {
            cmd: parseWorkCommand(service.cwd, service.schema.healthcheck, envs),
          }
        : null,
      envs: buildEnvironmentVariables(service.envs, environment),
      image: service.schema.image,
      cwd: service.cwd,
      cmd: service.schema.cmd ? parseWorkCommand(service.cwd, service.schema.cmd, envs) : null,
      volumes: parseWorkVolumes(service.cwd, service.schema.volumes, envs),
      mounts: parseWorkMounts(service.cwd, service.schema, envs),
      src: parseWorkSource(service.cwd, service.schema.src, envs),
    }
  }
}
