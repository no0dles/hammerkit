import { BuildFile } from '../../parser/build-file'
import { WorkNode } from '../work-node'
import { WorkNodes } from '../work-nodes'
import { WorkContext } from '../work-context'
import { planWorkNode } from './plan-work-node'

export function planWorkDependency(
  build: BuildFile,
  node: WorkNode,
  taskName: string,
  dep: string,
  nodes: WorkNodes,
  context: WorkContext
) {
  const depNode = planWorkNode(build, dep, nodes, {
    ...context,
    idPrefix: null,
  })
  if (!depNode) {
    throw new Error(`unable to find dependency ${dep} for task ${taskName} in ${build.path}`)
  }
  node.deps.push(depNode)

  for (const src of depNode.src) {
    if (node.src.indexOf(src) === -1) {
      node.src.push(src)
    }
  }
  for (const generate of depNode.generates) {
    if (node.generates.indexOf(generate) === -1) {
      node.generates.push(generate)
    }
  }

  if (!node.status.pendingDependencies[depNode.id]) {
    node.status.pendingDependencies[depNode.id] = depNode
  }
  for (const dep of depNode.deps) {
    if (!node.status.pendingDependencies[dep.id]) {
      node.status.pendingDependencies[dep.id] = dep
    }
  }
}
