import { createHash } from 'crypto'
import { basename } from 'path'
import { WorkItem } from '../planner/work-item'
import { WorkService } from '../planner/work-service'
import { WorkTask } from '../planner/work-task'

// The paths a work item keeps in its claim, in the order getKubernetesPersistence mounts
// them. Its consumers mount its outputs by the same paths, so they find the same folders.
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
// service's data among them). The paths after the first one with the same last segment
// also carry a hash of the whole path, so each has a folder of its own.
export function getClaimSubPath(work: Pick<WorkItem<WorkTask | WorkService>, 'data'>, path: string): string {
  const name = basename(path) || 'root'
  const first = getClaimPaths(work).find((other) => basename(other) === basename(path))
  if (first === undefined || first === path) {
    return name
  }
  return `${name}-${createHash('sha256').update(path).digest('hex').slice(0, 12)}`
}

// Whether two different paths of the claim of `work` end alike. Before getClaimSubPath
// named them apart, they shared one folder, and outputs made then are mixed.
export function hasPathsEndingAlike(work: Pick<WorkItem<WorkTask | WorkService>, 'data'>): boolean {
  const paths = new Set(getClaimPaths(work))
  return new Set([...paths].map((path) => basename(path))).size < paths.size
}
