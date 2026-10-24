import { getSecretName, parseWorkSecrets } from '../work-secret'
import { BaseWorkTask, ContainerWorkTask, LocalWorkTask, WorkEnvOrigin, WorkTask } from '../work-task'
import { parseWorkGenerate } from './parse-work-generate'
import { templateValue } from './template-value'
import { parseWorkMounts } from './parse-work-mounts'
import { getContainerUser } from './get-container-user'
import { ReferencedContext, ReferenceTask } from '../../schema/reference-parser'
import { isBuildFileContainerTaskSchema } from '../../schema/build-file-task-schema'
import { parseWorkCommands } from './parse-work-command'
import { parseWorkSource } from './parse-work-source'
import { WorkTree } from '../work-tree'
import { getWorkTaskId } from '../work-cache-id'
import { appendWorkDependencies } from './append-work-dependencies'
import { appendWorkNeeds } from './append-work-needs'
import { Environment } from '../../executer/environment'
import { WorkItem, WorkItemState } from '../work-item'
import { TaskState } from '../../executer/scheduler/task-state'
import { State } from '../../executer/state'
import { buildEnvironmentVariables } from '../../environment/replace-env-variables'
import { lazyResolver } from '../../executer/lazy-resolver'
import { getWorkTaskRuntime } from './get-work-runtime'
import { resolveCache } from '../../cache/resolve-cache'
import { parseDuration } from '../../utils/units'
import { parseWorkResources } from '../work-resources'
import { placeOnPool, runInToolImage } from '../../kubernetes/job-placement'
import { BuildFileLocalTaskSchema } from '../../schema/build-file-local-task-schema'
import { formatNetwork, parseWorkNetwork } from '../work-network'

export function appendWorkTask(
  workTree: WorkTree,
  cwd: string,
  referenceTask: ReferenceTask,
  environment: Environment,
  context: ReferencedContext
): WorkItemState<WorkTask, TaskState> {
  const parsed = parseTask(cwd, referenceTask, environment, context)
  // on a server's cluster a local task runs in a tool image like a container task
  const server = workTree.environment.type === 'kubernetes' ? workTree.environment.server : undefined
  const task = !server
    ? parsed
    : parsed.type === 'local-task'
      ? runInToolImage(parsed, server, (referenceTask.schema as BuildFileLocalTaskSchema).platform)
      : placeOnPool(parsed, server)
  if (!workTree.tasks[task.name]) {
    const workItem: WorkItem<WorkTask> = {
      // A dependency cycle is rejected before anything runs (checkForLoop), but
      // the id may be asked for earlier; re-entry yields a placeholder instead of
      // recursing forever.
      id: lazyResolver(
        () => getWorkTaskId(workItem),
        () => `cycle:${task.name}`
      ),
      name: task.name,
      data: task,
      status: environment.status.from(task),
      needs: [],
      deps: [],
      requiredBy: [],
    }
    const workItemState: WorkItemState<WorkTask, TaskState> = {
      ...workItem,
      state: new State<TaskState>({
        type: 'pending',
        stateKey: null,
      }),
      runtime: getWorkTaskRuntime(workTree, workItem),
    }
    workTree.tasks[task.name] = workItemState
    appendWorkDependencies(workTree, referenceTask, workItemState, environment, context)
    appendWorkNeeds(workTree, referenceTask, workItemState, environment, context)
    return workItemState
  } else {
    return workTree.tasks[task.name]
  }
}

function parseTask(
  cwd: string,
  task: ReferenceTask,
  environment: Environment,
  context: ReferencedContext
): ContainerWorkTask | LocalWorkTask {
  const envs = buildEnvironmentVariables(task.envs, environment, context)
  const baseWorkNode: BaseWorkTask = {
    envs,
    envOrigins: getEnvOrigins(task),
    description: templateValue(task.schema.description || '', envs).trim(),
    name: task.relativeName,
    cwd,
    projectRoot: context.projectRoot,
    cmds: parseWorkCommands(cwd, task.schema.cmds || [], envs),
    src: parseWorkSource(cwd, task.schema.src, envs),
    generates: parseWorkGenerate(cwd, task.schema, envs),
    scope: task.scope,
    labels: task.labels,
    caching: resolveCache(task.schema.cache ?? null, context.caches, task.relativeName),
    shell: task.schema.shell ? templateValue(task.schema.shell, envs) : '/bin/sh',
    continuous: task.schema.continuous ?? false,
    timeout: task.schema.timeout ? parseDuration(task.schema.timeout) : null,
    secrets: parseWorkSecrets(
      cwd,
      context.projectRoot,
      task.schema.secrets,
      envs,
      environment,
      context.secrets,
      task.schema.account
    ),
    resources: parseWorkResources(task.schema.resources),
    network: parseWorkNetwork(task.schema.network),
    networkCeiling: null,
    args: task.schema.args ?? null,
    runner: task.schema.runner ?? task.scope.schema.runner ?? null,
  }

  if (isBuildFileContainerTaskSchema(task.schema)) {
    return <ContainerWorkTask>{
      ...baseWorkNode,
      type: 'container-task',
      user: getContainerUser(),
      image: templateValue(task.schema.image, envs),
      mounts: parseWorkMounts(cwd, task.schema, envs),
      volumeSize: task.schema.volumeSize ?? null,
    }
  } else {
    const fileSecret = baseWorkNode.secrets.find((secret) => secret.target.type === 'file')
    if (fileSecret) {
      throw new Error(
        `task ${task.relativeName}: a local task takes secrets as env only (${getSecretName(fileSecret)})`
      )
    }
    // on a server's cluster it runs in a pod of a pool's tool image (runInToolImage)
    const contained = !!environment.hosted?.kubernetes || !!environment.hosted?.localTasksInContainers
    if (baseWorkNode.network.type !== 'open' && !contained) {
      throw new Error(
        `task ${task.relativeName}: network ${formatNetwork(baseWorkNode.network)} needs a container, ` +
          `hammerkit can't limit the network of a local task`
      )
    }
    return <LocalWorkTask>{
      ...baseWorkNode,
      type: 'local-task',
    }
  }
}

function getEnvOrigins(task: ReferenceTask): { [key: string]: WorkEnvOrigin } {
  const origins: { [key: string]: WorkEnvOrigin } = {}
  for (const key of Object.keys(task.envs)) {
    if (key in (task.schema.envs ?? {})) {
      origins[key] = 'task'
    } else if (key in (task.scope.inputs ?? {}) && key in (task.scope.schema.envs ?? {})) {
      origins[key] = 'input'
    } else if (key in (task.scope.schema.envs ?? {})) {
      origins[key] = 'build-file'
    } else {
      origins[key] = 'extend'
    }
  }
  return origins
}
