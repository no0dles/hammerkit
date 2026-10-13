import { createHash } from 'crypto'
import { WorkItem } from './work-item'
import { WorkTask } from './work-task'

// The state record says "the outputs at this task's paths were made by this
// variant of the task (its id), from this state key". It is kept per task
// *name*, because every variant of a task (other arguments after --, another
// --set value) writes the same output paths: a record per id would let a run of
// one variant overwrite the outputs while the record of another one still
// claims them. The id stored with the key makes the next run of that other
// variant a miss.
export function getStateRecordName(task: WorkItem<WorkTask>): string {
  return createHash('sha1').update(`${task.name}\0${task.data.projectRoot}`).digest('hex')
}

export function formatStateRecord(task: WorkItem<WorkTask>, stateKey: string): string {
  return `${task.id()}:${stateKey}`
}

// The state key of the record when this variant made the outputs, else null.
export function parseStateRecord(task: WorkItem<WorkTask>, content: string): string | null {
  const record = content.trim()
  const separator = record.indexOf(':')
  if (separator < 0 || record.slice(0, separator) !== task.id()) {
    return null
  }
  return record.slice(separator + 1) || null
}
