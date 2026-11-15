import { isAbsolute, relative, sep } from 'path'
import { WorkTask } from '../work-task'

// Whether a path is a file a dependency of the task generates, or is, or is inside, a folder
// one generates. The task sees what the dependency made there: a src at such a path stays a
// src of the task (its id and its cache key are as they were), but isn't bound or mounted over
// the output, as docker would bind the host's folder (empty where the dependency ran in a
// container) and a pod would mount the same path twice. A `build` whose context a dependency
// writes reads it so, and a deploy that lists the digest file of its image in its src.
export function isDependencyOutput(task: Pick<WorkTask, 'generates'>, path: string): boolean {
  return task.generates.some(
    (generate) => generate.inherited && (generate.path === path || (!generate.isFile && isInside(generate.path, path)))
  )
}

function isInside(folder: string, path: string): boolean {
  const rel = relative(folder, path)
  return rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}
