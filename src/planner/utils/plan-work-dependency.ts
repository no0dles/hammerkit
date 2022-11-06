import { isContainerWorkNode, WorkNode } from '../work-node'
import { getVolumeName } from './plan-work-volume'

export function planWorkDependency(deps: WorkNode[], node: WorkNode): void {
  for (const depNode of deps) {
    if (node.deps.some((d) => d.id === depNode.id)) {
      continue
    }

    node.deps.push(depNode)

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

    if (isContainerWorkNode(depNode) && isContainerWorkNode(node)) {
      for (const volume of depNode.volumes) {
        if (!node.volumes.some((v) => v.name === volume.name)) {
          node.volumes.push(volume)
        }
      }
    }

    planWorkDependency(depNode.deps, node)
  }
}
