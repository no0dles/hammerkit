import { WorkTree } from '../work-tree'
import { ReferencedContext, ReferenceService } from '../../schema/reference-parser'
import { getWorkServiceId } from '../work-service-id'
import {
  BaseWorkService,
  ContainerWorkService,
  KubernetesWorkService,
  WorkService,
  WorkServiceInit,
} from '../work-service'
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
import { buildEnvironmentVariables, WorkEnvironmentVariables } from '../../environment/replace-env-variables'
import { mergeEnvironmentVariables } from '../../environment/merge-environment-variables'
import { BuildFileContainerServiceSchema } from '../../schema/build-file-container-service-schema'
import { ServiceState } from '../../executer/scheduler/service-state'
import { State } from '../../executer/state'
import { lazyResolver } from '../../executer/lazy-resolver'
import { getWorkServiceRuntime } from './get-work-runtime'
import { resolveCache } from '../../cache/resolve-cache'
import { parseDuration } from '../../utils/units'
import { getErrorMessage } from '../../log'

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
    projectRoot: context.projectRoot,
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
      continuous: service.schema.continuous ?? false,
      healthcheck: service.schema.healthcheck
        ? {
            cmd: parseWorkCommand(service.cwd, service.schema.healthcheck.cmd, envs),
            timeout: getHealthcheckTimeout(service.schema.healthcheck.timeout, environment),
          }
        : null,
      envs: buildEnvironmentVariables(service.envs, environment, context),
      image: templateValue(service.schema.image, envs),
      cwd: service.cwd,
      cmd: service.schema.cmd ? parseWorkCommand(service.cwd, service.schema.cmd, envs) : null,
      workdir: service.schema.workdir ? templateValue(service.schema.workdir, envs) : null,
      shell: service.schema.shell ? templateValue(service.schema.shell, envs) : null,
      volumes: parseWorkVolumes(service.cwd, service.schema.volumes, envs),
      mounts: parseWorkMounts(service.cwd, service.schema, envs),
      src: parseWorkSource(service.cwd, service.schema.src, envs),
      caching,
      init: parseServiceInit(service, envs, environment, context),
    }
  }
}

function parseServiceInit(
  service: ReferenceService,
  serviceEnvs: WorkEnvironmentVariables,
  environment: Environment,
  context: ReferencedContext
): WorkServiceInit | null {
  if (isBuildFileKubernetesServiceSchema(service.schema) || !service.schema.init) {
    return null
  }
  const init = service.schema.init
  // the init sees the service's env values, its own on top
  const envs = buildEnvironmentVariables(mergeEnvironmentVariables(init.envs, service.envs), environment, context)
  return {
    image: init.image ? templateValue(init.image, envs) : templateValue(service.schema.image, serviceEnvs),
    shell: init.shell ? templateValue(init.shell, envs) : 'sh',
    cmds: init.cmds.map((cmd) => parseWorkCommand(service.cwd, cmd, envs)),
    envs,
    mounts: parseWorkMounts(service.cwd, { mounts: init.mounts } as BuildFileContainerServiceSchema, envs),
    timeout: getInitTimeout(init.timeout, environment),
  }
}

export const DEFAULT_INIT_TIMEOUT = '5m'

// A service's own `init.timeout`, else HAMMERKIT_INIT_TIMEOUT, else 5 minutes:
// an init that never ends would otherwise keep the run waiting.
export function getInitTimeout(timeout: string | undefined, environment: Environment): number {
  if (timeout) {
    return parseDuration(timeout)
  }
  const fromEnv = environment.processEnvs.HAMMERKIT_INIT_TIMEOUT
  if (fromEnv) {
    try {
      return parseDuration(fromEnv)
    } catch (e) {
      throw new Error(`HAMMERKIT_INIT_TIMEOUT: ${getErrorMessage(e)}`)
    }
  }
  return parseDuration(DEFAULT_INIT_TIMEOUT)
}

export const DEFAULT_HEALTHCHECK_TIMEOUT = '20s'

// A service's own `healthcheck.timeout`, else HAMMERKIT_HEALTHCHECK_TIMEOUT,
// else 20s: a check that never passes fails the run instead of hanging it.
export function getHealthcheckTimeout(timeout: string | undefined, environment: Environment): number {
  if (timeout) {
    return parseDuration(timeout)
  }
  const fromEnv = environment.processEnvs['HAMMERKIT_HEALTHCHECK_TIMEOUT']
  if (fromEnv) {
    try {
      return parseDuration(fromEnv)
    } catch (e) {
      throw new Error(`HAMMERKIT_HEALTHCHECK_TIMEOUT: ${getErrorMessage(e)}`)
    }
  }
  return parseDuration(DEFAULT_HEALTHCHECK_TIMEOUT)
}
