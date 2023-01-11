import { PlannedTask } from './planned-task'
import { WorkContext } from '../work-context'
import { BaseWorkNode, WorkNode } from '../work-node'
import { parseLocalWorkNodeGenerate } from './parse-local-work-node-generate'
import { templateValue } from './template-value'
import { parseWorkNodeCommand } from './parse-work-node-command'
import { parseLocalWorkNodeSource } from './parse-local-work-node-source'
import { mapLabels } from './map-labels'
import { getMounts } from './get-mounts'
import { parseContainerWorkNodeMount } from './parse-container-work-node-mount'
import { getContainerUser } from './get-container-user'
import { parseContainerWorkNodePorts } from './parse-container-work-node-ports'
import { getContainerVolumes } from './plan-work-volume'
import { getWorkService } from './parse-work-node-needs'

export function parseWorkNode(id: string, task: PlannedTask, context: WorkContext): WorkNode {
  const name = [...context.namePrefix, task.name].join(':')

  const generates = parseLocalWorkNodeGenerate(task, context, task.envs)
  const baseWorkNode: BaseWorkNode = {
    envs: task.envs,
    id,
    description: templateValue(task.description, task.envs),
    continuous: task.continuous,
    name,
    cwd: task.cwd,
    cmds: parseWorkNodeCommand(task, context, task.envs),
    deps: [],
    buildFile: task.build,
    taskName: task.name,
    src: parseLocalWorkNodeSource(task, context, task.envs),
    generates,
    plannedTask: task,
    needs: [],
    labels: mapLabels(task.labels),
    caching: task.cache ?? null,
  }

  for (const service of task.needs) {
    baseWorkNode.needs.push({
      name: service.name,
      service: getWorkService(service.reference.context, { name: service.reference.name }),
    })
  }

  if (task.image) {
    const mounts = getMounts(baseWorkNode, parseContainerWorkNodeMount(task, context, generates, task.envs))
    return {
      ...baseWorkNode,
      type: 'container',
      user: getContainerUser(),
      image: templateValue(task.image, task.envs),
      shell: templateValue(task.shell, task.envs) || '/bin/sh',
      mounts,
      ports: parseContainerWorkNodePorts(task, context, task.envs),
      volumes: getContainerVolumes(baseWorkNode, mounts),
    }
  } else {
    return {
      ...baseWorkNode,
      type: 'local',
    }
  }
}
