import { WorkNode } from '../work-node'
import { WorkContext } from '../work-context'
import { assignDependencies } from './assign-dependencies'
import { getWorkNodeId } from '../work-node-id'
import { BuildFileNameSelector, findBuildTask } from './find-build-value'
import { planTask } from './plan-task'
import { parseWorkNode } from './parse-work-node'

export function getWorkNode(context: WorkContext, selector: BuildFileNameSelector): WorkNode {
  const rootNode = findBuildTask(context, selector)
  const plannedTask = planTask(rootNode.context, rootNode)
  const id = getWorkNodeId(plannedTask)
  if (context.nodes[id]) {
    return context.nodes[id]
  }

  const node = parseWorkNode(id, plannedTask, rootNode.context)
  context.nodes[id] = node

  assignDependencies(plannedTask.deps, node)

  return node
}
