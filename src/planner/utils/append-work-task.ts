import { BaseWorkTask, ContainerWorkTask, LocalWorkTask, WorkTask } from '../work-task'
import { parseWorkGenerate } from './parse-work-generate'
import { templateValue } from './template-value'
import { parseWorkMounts } from './parse-work-mounts'
import { getContainerUser } from './get-container-user'
import { ReferenceTask } from '../../schema/reference-parser'
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

export function appendWorkTask(
  workTree: WorkTree,
  cwd: string,
  referenceTask: ReferenceTask,
  environment: Environment
): WorkItemState<WorkTask, TaskState> {
  const task = parseTask(cwd, referenceTask, environment)
  if (!workTree.tasks[task.name]) {
    const workItem: WorkItem<WorkTask> = {
      id: lazyResolver(() => getWorkTaskId(task)),
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
    appendWorkDependencies(workTree, referenceTask, workItemState, environment)
    appendWorkNeeds(workTree, referenceTask, workItemState, environment)
    return workItemState
  } else {
    return workTree.tasks[task.name]
  }
}

function parseTask(cwd: string, task: ReferenceTask, environment: Environment): ContainerWorkTask | LocalWorkTask {
  const envs = buildEnvironmentVariables(task.envs, environment)
  const baseWorkNode: BaseWorkTask = {
    envs,
    description: templateValue(task.schema.description || '', envs).trim(),
    name: task.relativeName,
    cwd,
    cmds: parseWorkCommands(cwd, task.schema.cmds || [], envs),
    src: parseWorkSource(cwd, task.schema.src, envs),
    generates: parseWorkGenerate(cwd, task.schema, envs),
    scope: task.scope,
    labels: task.labels,
    caching: task.schema.cache ?? null,
    shell: task.schema.shell ? templateValue(task.schema.shell, envs) : '/bin/sh',
  }

  if (isBuildFileContainerTaskSchema(task.schema)) {
    return <ContainerWorkTask>{
      ...baseWorkNode,
      type: 'container-task',
      user: getContainerUser(),
      image: templateValue(task.schema.image, envs),
      mounts: parseWorkMounts(cwd, task.schema, envs),
    }
  } else {
    return <LocalWorkTask>{
      ...baseWorkNode,
      type: 'local-task',
    }
  }
}
