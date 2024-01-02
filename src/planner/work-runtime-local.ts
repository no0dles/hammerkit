import { ExecuteOptions, WorkRuntime } from '../runtime/runtime'
import { LocalWorkTask } from './work-task'
import { TaskState } from '../executer/scheduler/task-state'
import { WorkItem } from './work-item'
import { Environment } from '../executer/environment'
import { create, extract } from 'tar'
import { relative } from 'path'
import { localTask } from '../executer/local-task'
import { getArchivePaths } from '../executer/event-cache'

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
    },
    async stop(): Promise<void> {
      // TODO check for running tasks
    },
    currentStateKey(): Promise<string | null> {
      return Promise.resolve(null) // TODO document changes, local no caching or implement new file cache
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
