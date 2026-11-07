import { createHash } from 'crypto'
import { basename, relative, sep } from 'path'
import { WorkItem } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { WorkTask } from '../planner/work-task'
import { portablePath } from '../planner/utils/portable-path'

// The paths a work item keeps in its claim. Its consumers mount its outputs by the same
// paths, so they find the same folders.
function getClaimPaths(work: Pick<WorkItem<WorkTask | WorkService>, 'data'>): string[] {
  const data = work.data
  const paths: string[] = []
  if ('mounts' in data) {
    paths.push(...data.mounts.map((mount) => mount.containerPath))
  }
  if ('src' in data) {
    paths.push(...data.src.filter((src) => !src.inherited).map((src) => src.absolutePath))
  }
  if ('generates' in data) {
    paths.push(...data.generates.filter((generate) => !generate.inherited).map((generate) => generate.path))
  }
  if ('volumes' in data) {
    paths.push(...data.volumes.filter((volume) => !volume.inherited).map((volume) => volume.containerPath))
  }
  return paths
}

// Where `path` is in the claim of `work`, relative to its root. A path is named after its
// last segment, so claims without two such paths are laid out as they always were (a
// service's data among them). Of the paths with the same last segment, the least deep one
// (then the first in sorted order) keeps the name, and the others also carry a hash of
// their path. Both go by the path
// relative to the project, as the task's id does, so a run in another checkout directory
// (each run of a server has its own) or with its `generates` in another order finds the
// same folders in a kept claim.
export function getClaimSubPath(work: Pick<WorkItem<WorkTask | WorkService>, 'data'>, path: string): string {
  const name = basename(path) || 'root'
  const alike = getClaimPaths(work).filter((other) => other !== path && basename(other) === basename(path))
  if (alike.length === 0) {
    return name
  }
  const own = portablePath(work.data.projectRoot, path)
  const first = [own, ...alike.map((other) => portablePath(work.data.projectRoot, other))].sort(byDepth)[0]
  if (first === own) {
    return name
  }
  return `${name}-${createHash('sha256').update(own).digest('hex').slice(0, 12)}`
}

export function byDepth(a: string, b: string): number {
  return a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0)
}

// Whether two different paths of the claim of `work` end alike. Before getClaimSubPath
// named them apart, they shared one folder, and outputs made then are mixed.
export function hasPathsEndingAlike(work: Pick<WorkItem<WorkTask | WorkService>, 'data'>): boolean {
  const paths = new Set(getClaimPaths(work))
  return new Set([...paths].map((path) => basename(path))).size < paths.size
}

// Whether two outputs of `work` flatten to the same name of a cache archive (`a-b` and
// `a/b`, see getArchivePaths). Before they were named apart, one archive held both.
export function hasOutputsFlatteningAlike(work: Pick<WorkItem<WorkTask | WorkService>, 'data'>): boolean {
  const data = work.data
  if (!('generates' in data) || !('cwd' in data)) {
    return false
  }
  const paths = new Set(data.generates.filter((generate) => !generate.inherited).map((generate) => generate.path))
  const names = new Set([...paths].map((path) => relative(data.cwd, path).split(sep).join('-')))
  return names.size < paths.size
}
