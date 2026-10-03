import { isAbsolute, relative } from 'path'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkTask } from '../planner/work-task'
import { ContainerBind } from './container-bind'

function isInside(path: string, parent: string): boolean {
  const rel = relative(parent, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function getContainerBinds(item: WorkItem<ContainerWorkTask>): ContainerBind[] {
  const sources = item.data.src.map((s) => s.absolutePath)
  const items: ContainerBind[] = [
    ...item.data.mounts,
    // A source inside another source (a dependency's `app/app.csproj` under the
    // task's own `app`) is already visible through the outer bind. Binding it
    // again would nest bind mounts, which Docker Desktop then refuses to let the
    // host delete while the container exists.
    ...sources
      .filter((path) => !sources.some((other) => isInside(path, other)))
      .map((path) => ({ localPath: path, containerPath: path })),
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
