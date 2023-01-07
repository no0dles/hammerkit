import { isContainerWorkNode, isWorkNode, WorkNode } from '../work-node'
import { isContainerWorkService, WorkService } from '../work-service'
import { templateValue } from './template-value'
import { BuildFileReference } from './build-file-reference'
import { getWorkNode } from './plan-work-node'

export function assignDependencies(deps: BuildFileReference[], node: WorkNode | WorkService): void {
  const depNodes: WorkNode[] = []
  for (const dep of deps) {
    const depName = templateValue(dep.name, dep.build.envs)
    const depNode = getWorkNode(dep.context, { name: depName })
    if (!depNodes.some((d) => d.id === depNode.id)) {
      depNodes.push(depNode)
    }
  }

  for (const depNode of depNodes) {
    if (node.deps.some((d) => d.id === depNode.id)) {
      continue
    }

    node.deps.push(depNode)

    if (isWorkNode(node)) {
      for (const src of depNode.src) {
        if (node.src.indexOf(src) === -1) {
          node.src.push(src)

          if (isContainerWorkNode(node)) {
            node.mounts.push({
              localPath: src.absolutePath,
              containerPath: src.absolutePath,
            })
          }
        }
      }
    }

    if (isContainerWorkNode(depNode) && (isContainerWorkNode(node) || isContainerWorkService(node))) {
      for (const volume of depNode.volumes) {
        if (!node.volumes.some((v) => v.name === volume.name)) {
          node.volumes.push({
            ...volume,
            inherited: true,
          })
        }
      }
    }
  }
}
