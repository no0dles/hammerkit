import { WorkTree } from '../work-tree'
import { ReferencedContext, ReferenceService } from '../../schema/reference-parser'
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
import { WorkItem, WorkItemState } from '../work-item'
import { buildEnvironmentVariables } from '../../environment/replace-env-variables'
import { ServiceState } from '../../executer/scheduler/service-state'
import { State } from '../../executer/state'
import { lazyResolver } from '../../executer/lazy-resolver'
import { getWorkServiceRuntime } from './get-work-runtime'
import { resolveCache } from '../../cache/resolve-cache'

export function appendWorkService(
  workTree: WorkTree,
  service: ReferenceService,
  environment: Environment,
  context: ReferencedContext
): WorkItemState<WorkService, ServiceState> {
  const workService = parseService(workTree, service, environment, context)
  if (!workTree.services[workService.name]) {
    const workItem: WorkItem<WorkService> = {
      id: lazyResolver(() => getWorkServiceId(workService)),
      name: workService.name,
      data: workService,
      status: environment.status.from(workService),
      deps: [],
      needs: [],
      requiredBy: [],
    }
    const workStateItem: WorkItemState<WorkService, ServiceState> = {
      ...workItem,
      state: new State<ServiceState>({
        type: 'pending',
        stateKey: null,
      }),
      runtime: getWorkServiceRuntime(workTree, workItem),
    }
    workTree.services[workItem.name] = workStateItem
    appendWorkDependencies(workTree, service, workStateItem, environment, context)
    appendWorkNeeds(workTree, service, workStateItem, environment, context)
    return workStateItem
  } else {
    return workTree.services[workService.name]
  }
}

function parseService(
  workTree: WorkTree,
  service: ReferenceService,
  environment: Environment,
  context: ReferencedContext
): WorkService {
  const envs = buildEnvironmentVariables(service.envs, environment, context)
  const workService: BaseWorkService = {
    cwd: service.cwd,
    name: service.relativeName,
    ports: parseWorkPorts(service.schema, envs),
    scope: service.scope,
    labels: service.labels,
    description: templateValue(service.schema.description || '', envs),
  }

  const caching = resolveCache(null, context.caches, service.relativeName)

  if (isBuildFileKubernetesServiceSchema(service.schema)) {
    const k8sEnv = workTree.environment.type === 'kubernetes' ? workTree.environment : undefined
    const kubeconfig = service.schema.kubeconfig ?? k8sEnv?.kubeConfig ?? getDefaultKubeConfig()
    const serviceContext = service.schema.context ? templateValue(service.schema.context, envs) : k8sEnv?.context
    if (!serviceContext) {
      throw new Error(
        `kubernetes service ${service.relativeName} has no context: set "context" on the service or select a ` +
          `kubernetes environment (environments.<name>.kubernetes.context) with --env`
      )
    }
    const namespace = service.schema.namespace
      ? templateValue(service.schema.namespace, envs)
      : k8sEnv?.namespace ?? 'default'
    return <KubernetesWorkService>{
      type: 'kubernetes-service',
      ...workService,
      kubeconfig,
      namespace,
      selector: {
        name: templateValue(service.schema.selector.name, envs),
        type: templateValue(service.schema.selector.type, envs),
      },
      context: serviceContext,
      src: [createSource(kubeconfig)],
      caching,
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
      envs: buildEnvironmentVariables(service.envs, environment, context),
      image: service.schema.image,
      cwd: service.cwd,
      cmd: service.schema.cmd ? parseWorkCommand(service.cwd, service.schema.cmd, envs) : null,
      volumes: parseWorkVolumes(service.cwd, service.schema.volumes, envs),
      mounts: parseWorkMounts(service.cwd, service.schema, envs),
      src: parseWorkSource(service.cwd, service.schema.src, envs),
      caching,
    }
  }
}
