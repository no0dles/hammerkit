import { parseWorkSecrets } from '../work-secret'
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
import { isContainerWorkServiceItem, WorkItem, WorkItemState } from '../work-item'
import { appendWorkTask } from './append-work-task'
import { buildEnvironmentVariables } from '../../environment/replace-env-variables'
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
    appendServiceInit(workTree, service, workStateItem, environment, context)
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
      // set once the service is planned, see appendServiceInit
      init: null,
      secrets: parseWorkSecrets(service.cwd, context.projectRoot, service.schema.secrets, envs, environment),
    }
  }
}

// The task named by `init` is planned like any other task. It needs the
// service under the service's name, but through a view of it that turns running
// once the healthcheck passed; the service itself only runs for everything else
// once the init succeeded. The init never makes the service start (it is not
// among the service's requirers), never comes from the cache, and gets the init
// timeout unless it declares its own.
function appendServiceInit(
  workTree: WorkTree,
  service: ReferenceService,
  item: WorkItemState<WorkService, ServiceState>,
  environment: Environment,
  context: ReferencedContext
) {
  if (!service.init || !isContainerWorkServiceItem(item)) {
    return
  }
  const task = appendWorkTask(workTree, service.init.cwd, service.init.task, environment, context)
  const state = new State<ServiceState>({ type: 'pending', stateKey: null })
  const view: WorkItemState<WorkService, ServiceState> = { ...item, state }
  initViews.set(view, item)
  const selfNeed = task.needs.findIndex((need) => need.service.name === item.name)
  if (selfNeed >= 0) {
    task.needs[selfNeed] = { name: task.needs[selfNeed].name, service: view }
  } else {
    task.needs.push({ name: item.name, service: view })
  }
  removeRequirer(item, task.name)
  task.data.caching = { ...task.data.caching, method: 'none' }
  if (task.data.timeout === null) {
    task.data.timeout = getInitTimeout(undefined, environment)
  }
  item.data.init = { task, state }
}

const initViews = new WeakMap<WorkItem<WorkService>, WorkItemState<WorkService, ServiceState>>()

// The service itself for the view its init task needs, else the item.
export function getPlannedService(
  item: WorkItemState<WorkService, ServiceState>
): WorkItemState<WorkService, ServiceState> {
  return initViews.get(item) ?? item
}

function removeRequirer(item: WorkItemState<WorkService, ServiceState>, name: string) {
  const index = item.requiredBy.findIndex((requirer) => requirer.name === name)
  if (index >= 0) {
    item.requiredBy.splice(index, 1)
  }
}

export const DEFAULT_INIT_TIMEOUT = '5m'

// The init task's own `timeout`, else HAMMERKIT_INIT_TIMEOUT, else 5 minutes:
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
