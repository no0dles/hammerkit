import { join } from 'path'
import { Environment } from './environment'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkTask } from '../planner/work-task'
import { getHammerkitDirectory } from '../optimizer/get-cache-directory'
import { formatStateRecord, getStateRecordName, parseStateRecord } from '../planner/work-state-record'

// The record says "the outputs of this container task belong to this state
// key", like the state file of a local task (see work-state-record.ts). It lives
// in the hammerkit directory, not the project, so writing it never touches a
// task's src; the record name folds in the project root, so two checkouts keep
// their own.
export function getContainerTaskStateFile(task: WorkItem<ContainerWorkTask>): string {
  return join(getHammerkitDirectory(), 'state', getStateRecordName(task))
}

export async function readContainerTaskState(
  environment: Environment,
  task: WorkItem<ContainerWorkTask>
): Promise<string | null> {
  const stateFile = getContainerTaskStateFile(task)
  if (!(await environment.file.exists(stateFile))) {
    return null
  }
  return parseStateRecord(task, await environment.file.read(stateFile))
}

export async function writeContainerTaskState(
  environment: Environment,
  task: WorkItem<ContainerWorkTask>,
  stateKey: string
): Promise<void> {
  await environment.file.createDirectory(join(getHammerkitDirectory(), 'state'))
  await environment.file.writeFile(getContainerTaskStateFile(task), formatStateRecord(task, stateKey))
}

export async function removeContainerTaskState(
  environment: Environment,
  task: WorkItem<ContainerWorkTask>
): Promise<void> {
  const stateFile = getContainerTaskStateFile(task)
  if (await environment.file.exists(stateFile)) {
    await environment.file.remove(stateFile)
  }
}
