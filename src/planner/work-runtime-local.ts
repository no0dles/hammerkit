import { ExecuteOptions, WorkRuntime } from '../runtime/runtime'
import { LocalWorkTask } from './work-task'
import { TaskState } from '../executer/scheduler/task-state'
import { WorkItem } from './work-item'
import { Environment } from '../executer/environment'
import { create, extract } from 'tar'
import { join, relative } from 'path'
import { localTask } from '../executer/local-task'
import { getArchivePaths } from '../executer/event-cache'
import findProcess from 'find-process'

function getStateFilename(task: WorkItem<LocalWorkTask>) {
  return join(task.data.cwd, '.hammerkit', `${task.id()}`);
}

function getPidFilename(task: WorkItem<LocalWorkTask>) {
  return join(task.data.cwd, '.hammerkit', `${task.id()}.pid`)
}

async function readActivePid(task: WorkItem<LocalWorkTask>, environment: Environment): Promise<number | null> {
  const pidFile = getPidFilename(task)
  if (!(await environment.file.exists(pidFile))) {
    return null
  }
  const pid = parseInt((await environment.file.read(pidFile)).trim(), 10)
  if (!pid || pid === process.pid) {
    return null
  }
  const processes = await findProcess('pid', pid)
  if (processes.length === 0) {
    await environment.file.remove(pidFile)
    return null
  }
  return pid
}

export function getLocalWorkRuntime(task: WorkItem<LocalWorkTask>): WorkRuntime<TaskState> {
  return {
    async initialize(): Promise<void> {
      // pidfile check happens in execute (initialize has no Environment in scope)
    },
    async restore(environment: Environment, path: string): Promise<void> {
      await restoreLocal(environment, task.data, path)
    },
    async archive(environment: Environment, path: string): Promise<void> {
      await archiveLocal(environment, task, path)
    },
    async execute(environment: Environment, options: ExecuteOptions<TaskState>): Promise<void> {
      const activePid = await readActivePid(task, environment)
      if (activePid !== null) {
        options.state.set({
          type: 'error',
          stateKey: options.stateKey,
          errorMessage: `task ${task.name} is already running (pid ${activePid})`,
        })
        return
      }
      await environment.file.createDirectory(join(task.data.cwd, '.hammerkit'))
      const pidFile = getPidFilename(task)
      await environment.file.writeFile(pidFile, `${process.pid}`)
      try {
        await localTask(task, environment, options)
        await environment.file.writeFile(getStateFilename(task), options.stateKey)
      } finally {
        if (await environment.file.exists(pidFile)) {
          await environment.file.remove(pidFile)
        }
      }
    },
    async stop(): Promise<void> {
      // pidfile is cleaned up by execute()'s finally block; stale entries are
      // detected by readActivePid() on the next run.
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
