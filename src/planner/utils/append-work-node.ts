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
import { WorkItem } from '../work-item'

export function appendWorkNode(
  workTree: WorkTree,
  cwd: string,
  task: ReferenceTask,
  environment: Environment
): WorkItem<WorkNode> {
  const node = parseNode(cwd, task)
  const nodeId = getWorkNodeId(node)
  if (!workTree.nodes[nodeId]) {
    const workTreeNode: WorkItem<WorkNode> = {
      id: nodeId,
      name: node.name,
      data: node,
      status: environment.status.from(nodeId, node),
      needs: [],
      deps: [],
    }
    workTree.nodes[nodeId] = workTreeNode
    appendWorkDependencies(workTree, task, workTreeNode, environment)
    appendWorkNeeds(workTree, task, workTreeNode, environment)
    return workTreeNode
  } else {
    // TODO check for conflicts
    return workTree.nodes[nodeId]
  }
}

function parseNode(cwd: string, task: ReferenceTask): ContainerWorkNode | LocalWorkNode {
  const baseWorkNode: BaseWorkNode = {
    envs: task.envs,
    description: templateValue(task.schema.description || '', task.envs).trim(),
    name: task.relativeName,
    cwd,
    cmds: parseWorkCommands(cwd, task.schema.cmds || [], task.envs),
    src: parseWorkSource(cwd, task.schema.src, task.envs),
    generates: parseWorkGenerate(cwd, task.schema, task.envs),
    scope: task.scope,
    labels: task.labels,
    caching: task.schema.cache ?? null,
    shell: task.schema.shell ? templateValue(task.schema.shell, task.envs) : '/bin/sh',
  }

  if (isBuildFileContainerTaskSchema(task.schema)) {
    return <ContainerWorkNode>{
      ...baseWorkNode,
      type: 'container-task',
      user: getContainerUser(),
      image: templateValue(task.schema.image, task.envs),
      mounts: parseWorkMounts(cwd, task.schema, task.envs),
      volumes: parseWorkVolumes(cwd, task.schema.volumes), // TODO envs
    }
  } else {
    return <LocalWorkNode>{
      ...baseWorkNode,
      type: 'local-task',
    }
  }
}
