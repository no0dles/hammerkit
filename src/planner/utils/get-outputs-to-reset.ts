import { isAbsolute, relative } from 'path'
import { WorkTaskGenerate } from '../work-task'

function contains(parent: string, path: string): boolean {
  const rel = relative(parent, path)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// The outputs a run empties before the task's commands: its own outputs with
// resetOnChange (the default), except one that is a source or contains one
// (`package-lock.json` declared both ways) or contains the task's directory.
// Emptying those would delete what the task reads.
export function getOutputsToReset(task: {
  cwd: string
  src: { absolutePath: string }[]
  generates: WorkTaskGenerate[]
}): WorkTaskGenerate[] {
  return task.generates.filter(
    (generate) =>
      generate.resetOnChange &&
      !generate.inherited &&
      !contains(generate.path, task.cwd) &&
      !task.src.some((src) => contains(generate.path, src.absolutePath))
  )
}
