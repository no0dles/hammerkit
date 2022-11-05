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

    for (const generate of depNode.generates) {
      if (!node.generates.some((g) => g.path === generate.path)) {
        node.generates.push({ path: generate.path, inherited: true })

        if (isContainerWorkNode(node)) {
          const name = getVolumeName(generate.path)
          node.volumes.push({
            name,
            containerPath: generate.path,
          })
        }
      }
    }

    planWorkDependency(depNode.deps, node)
  }
}
