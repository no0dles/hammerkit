import { getSecretName, parseWorkSecrets } from '../work-secret'
import { BaseWorkTask, ContainerWorkTask, isAggregateTask, LocalWorkTask, WorkEnvOrigin, WorkTask } from '../work-task'
import { parseWorkGenerate } from './parse-work-generate'
import { templateValue } from './template-value'
import { parseWorkMounts } from './parse-work-mounts'
import { getContainerUser } from './get-container-user'
import { ReferencedContext, ReferenceTask } from '../../schema/reference-parser'
import { isBuildFileContainerTaskSchema, isBuildFileImageBuildTaskSchema } from '../../schema/build-file-task-schema'
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
import {
  BUILDKIT_IMAGE,
  getImageBuildCommand,
  getImageBuildGenerates,
  checkImageBuildEnvs,
  getImageBuildSecrets,
  getImageBuildSources,
  parseWorkImageBuild,
} from '../image-build'
import { BuildFileImageBuildTaskSchema } from '../../schema/build-file-image-build-schema'

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
  // an aggregate runs nothing, so it needs no pod either
  const task =
    !server || isAggregateTask(parsed)
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
  if (isBuildFileImageBuildTaskSchema(task.schema)) {
    return parseImageBuildTask(cwd, task, task.schema, environment, context)
  }
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
      // a capability holds for root only: a task that adds some runs as its image's user
      user: task.schema.capAdd?.length ? null : getContainerUser(),
      image: templateValue(task.schema.image, envs),
      mounts: parseWorkMounts(cwd, task.schema, envs),
      volumeSize: task.schema.volumeSize ?? null,
      capAdd: task.schema.capAdd ?? [],
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
    const aggregate =
      task.deps.length > 0 &&
      task.needs.length === 0 &&
      baseWorkNode.src.length === 0 &&
      baseWorkNode.cmds.length === 0 &&
      baseWorkNode.generates.length === 0 &&
      baseWorkNode.secrets.length === 0
    return <LocalWorkTask>{
      ...baseWorkNode,
      type: 'local-task',
      ...(aggregate ? { aggregate } : {}),
    }
  }
}

// A task that builds an image is the container task of BuildKit, with the command, sources,
// output and secrets of its `build` (see image-build.ts). It takes no arguments: they would go
// to buildctl, whose command line is hammerkit's.
function parseImageBuildTask(
  cwd: string,
  task: ReferenceTask,
  schema: BuildFileImageBuildTaskSchema,
  environment: Environment,
  context: ReferencedContext
): ContainerWorkTask {
  const envs = buildEnvironmentVariables(task.envs, environment, context)
  const build = parseWorkImageBuild(cwd, schema.build, envs, task.relativeName)
  const digest = getImageBuildGenerates(cwd, build)
  const generates = parseWorkGenerate(cwd, { ...schema, generates: [...(schema.generates ?? []), ...digest] }, envs)
  const secrets = parseWorkSecrets(
    cwd,
    context.projectRoot,
    [...(schema.secrets ?? []), ...getImageBuildSecrets(schema.build)],
    envs,
    environment,
    context.secrets,
    schema.account
  )
  checkImageBuildEnvs(
    [
      ...Object.keys(envs.variables),
      // the build file's own: those of the logins are hammerkit's
      ...(schema.secrets ?? []).flatMap((secret) => (secret.env ? [secret.env] : [])),
    ],
    task.relativeName
  )
  return {
    envs,
    envOrigins: getEnvOrigins(task),
    description: templateValue(schema.description || '', envs).trim(),
    name: task.relativeName,
    cwd,
    projectRoot: context.projectRoot,
    cmds: [{ cwd, cmd: getImageBuildCommand(cwd, build), parsed: { command: 'set', args: ['-e'] } }],
    src: parseWorkSource(cwd, schema.src ?? getImageBuildSources(cwd, build), envs),
    // the digest is a file whatever its name, which parseWorkGenerate goes by
    generates: generates.map((generate) => (generate.path === build.digest ? { ...generate, isFile: true } : generate)),
    scope: task.scope,
    labels: task.labels,
    caching: resolveCache(schema.cache ?? null, context.caches, task.relativeName),
    shell: '/bin/sh',
    timeout: schema.timeout ? parseDuration(schema.timeout) : null,
    secrets,
    resources: parseWorkResources(schema.resources),
    network: parseWorkNetwork(schema.network),
    networkCeiling: null,
    args: false,
    runner: schema.runner ?? task.scope.schema.runner ?? null,
    type: 'container-task',
    // BuildKit runs as root: SYS_ADMIN holds for root only
    user: null,
    image: BUILDKIT_IMAGE,
    mounts: [],
    volumeSize: schema.volumeSize ?? null,
    capAdd: ['SYS_ADMIN'],
    build,
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
