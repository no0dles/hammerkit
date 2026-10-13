import { createHash } from 'crypto'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { WorkTask } from './work-task'
import { WorkItem } from './work-item'

export function getWorkTaskId(item: WorkItem<WorkTask>): string {
  const description = getWorkTaskCacheDescription(item)
  const jsonData = JSON.stringify(description)
  return createHash('sha1').update(jsonData).digest('hex')
}

// The id of the task as the build file declares it: without the arguments
// after -- a run appended to its last command. A service's definition takes its
// init task by this id, so `run <init> -- ...` leaves a running service as it is.
export function getDeclaredWorkTaskId(item: WorkItem<WorkTask>): string {
  const description = getWorkTaskCacheDescription(item)
  const cmds = description.cmds?.map((cmd, index) => {
    const declared = item.data.cmds[index]
    return declared.arguments ? { ...cmd, cmd: declared.cmd.slice(0, declared.arguments.cmd) } : cmd
  })
  return createHash('sha1')
    .update(JSON.stringify({ ...description, cmds }))
    .digest('hex')
}
