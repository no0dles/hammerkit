import { WorkItem } from '../planner/work-item'
import { ContainerWorkNode } from '../planner/work-node'
import { ContainerBind } from './container-bind'

export function getContainerBinds(item: WorkItem<ContainerWorkNode>): ContainerBind[] {
  const items: ContainerBind[] = [
    ...item.data.mounts,
    ...item.data.volumes.map((v) => ({ localPath: v.name, containerPath: v.containerPath })),
    ...item.data.src.map((s) => ({ localPath: s.absolutePath, containerPath: s.absolutePath })),
    ...item.data.generates.filter((g) => !g.isFile).map((v) => ({ localPath: v.volumeName, containerPath: v.path })),
    ...item.data.generates.filter((g) => g.isFile).map((v) => ({ localPath: v.path, containerPath: v.path })),
  ]
  return items.reduce<ContainerBind[]>((array, item) => {
    if (array.findIndex((i) => i.containerPath === item.containerPath) === -1) {
      array.push(item)
    }
    return array
  }, [])
}
