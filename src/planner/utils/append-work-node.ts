import { BaseWorkNode, ContainerWorkNode, LocalWorkNode, WorkNode } from '../work-node'
import { parseWorkGenerate } from './parse-work-generate'
import { templateValue } from './template-value'
import { parseWorkMounts } from './parse-work-mounts'
import { getContainerUser } from './get-container-user'
import { ReferenceTask } from '../../schema/reference-parser'
import { isBuildFileContainerTaskSchema } from '../../schema/build-file-task-schema'
import { parseWorkCommands } from './parse-work-command'
import { parseWorkSource } from './parse-work-source'
import { WorkTree } from '../work-tree'
import { parseWorkVolumes } from './parse-work-volume'
import { getWorkNodeId } from '../work-node-id'
import { appendWorkDependencies } from './append-work-dependencies'
import { appendWorkNeeds } from './append-work-needs'
import { Environment } from '../../executer/environment'
import { WorkItemState } from '../work-item'
import { NodeState } from '../../executer/scheduler/node-state'
import { State } from '../../executer/state'
import { buildEnvironmentVariables } from '../../environment/replace-env-variables'

export function appendWorkNode(
  workTree: WorkTree,
  cwd: string,
  task: ReferenceTask,
  environment: Environment
): WorkItemState<WorkNode, NodeState> {
  const node = parseNode(cwd, task, environment)
  if (!workTree.nodes[node.name]) {
    const workTreeNode: WorkItemState<WorkNode, NodeState> = {
      id: () => getWorkNodeId(node), // TODO lazy caching
      name: node.name,
      data: node,
      status: environment.status.from(node),
      needs: [],
      deps: [],
      requiredBy: [],
      state: new State<NodeState>({
        type: 'pending',
        stateKey: null,
      }),
    }
    workTree.nodes[node.name] = workTreeNode
    appendWorkDependencies(workTree, task, workTreeNode, environment)
    appendWorkNeeds(workTree, task, workTreeNode, environment)
    return workTreeNode
  } else {
    return workTree.nodes[node.name]
  }
}

function parseNode(cwd: string, task: ReferenceTask, environment: Environment): ContainerWorkNode | LocalWorkNode {
  const envs = buildEnvironmentVariables(task.envs, environment)
  const baseWorkNode: BaseWorkNode = {
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
    return <ContainerWorkNode>{
      ...baseWorkNode,
      type: 'container-task',
      user: getContainerUser(),
      image: templateValue(task.schema.image, envs),
      mounts: parseWorkMounts(cwd, task.schema, envs),
      volumes: parseWorkVolumes(cwd, task.schema.volumes, envs),
    }
  } else {
    return <LocalWorkNode>{
      ...baseWorkNode,
      type: 'local-task',
    }
  }
}
