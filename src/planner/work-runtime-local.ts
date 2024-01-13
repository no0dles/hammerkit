import { ExecuteOptions, WorkRuntime } from '../runtime/runtime'
import { LocalWorkTask } from './work-task'
import { TaskState } from '../executer/scheduler/task-state'
import { WorkItem } from './work-item'
import { Environment } from '../executer/environment'
import { create, extract } from 'tar'
import { join, relative } from 'path'
import { localTask } from '../executer/local-task'
import { getArchivePaths } from '../executer/event-cache'

function getStateFilename(task: WorkItem<LocalWorkTask>) {
  return join(task.data.cwd, '.hammerkit', `${task.id()}`);
}

export function getLocalWorkRuntime(task: WorkItem<LocalWorkTask>): WorkRuntime<TaskState> {
  return {
    async initialize(): Promise<void> {
      // TODO check for running tasks
    },
    async restore(environment: Environment, path: string): Promise<void> {
      await restoreLocal(environment, task.data, path)
    },
    async archive(environment: Environment, path: string): Promise<void> {
      await archiveLocal(environment, task, path)
    },
    async execute(environment: Environment, options: ExecuteOptions<TaskState>): Promise<void> {
      await localTask(task, environment, options)
      await environment.file.createDirectory(join(task.data.cwd, '.hammerkit'))
      await environment.file.writeFile(getStateFilename(task), options.stateKey)
    },
    async stop(): Promise<void> {
      // TODO check for running tasks
    },
    async currentStateKey(environment: Environment): Promise<string | null> {
      const stateFileName = getStateFilename(task)
      if (await environment.file.exists(stateFileName)) {
        return await environment.file.read(stateFileName)
      }
      return Promise.resolve(null)
    },
    async remove(environment: Environment): Promise<void> {
      for (const generate of task.data.generates) {
        if (generate.inherited) {
          continue
        }
        task.status.write('info', `remove local directory ${generate.path}`)
        await environment.file.remove(generate.path)
      }
    },
  }
}

async function archiveLocal(environment: Environment, task: WorkItem<LocalWorkTask>, path: string) {
  for (const generatedArchive of getArchivePaths(task.data, path)) {
    await environment.file.writeStream(
      generatedArchive.filename,
      create(
        {
          cwd: task.data.cwd,
          gzip: true,
        },
        [relative(task.data.cwd, generatedArchive.path)]
      )
    )
  }
}

async function restoreLocal(environment: Environment, task: LocalWorkTask, path: string) {
  for (const generate of getArchivePaths(task, path)) {
    if (await environment.file.exists(generate.filename)) {
      await extract({
        file: generate.filename,
        cwd: task.cwd,
      })
    }
  }
}
