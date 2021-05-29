import { restructure, TreeDependencies, TreeDependencyNode } from './2-restructure'
import { optimize, writeCache } from './3-optimize'
import { plan, TaskNode } from './1-plan'
import { RunArg } from '../run-arg'
import { runLocally } from './4-execute-local'
import { runTaskDocker } from './4-execute-docker'
import { ExecutionBuildFile } from './0-parse'
import { watch } from 'fs'
import { join } from 'path'
import consola from 'consola'
import { Defer } from '../defer'

export interface TaskProcess {
  task: TaskNode
  start: Date
  promise: Promise<void>
}

export interface ExecuteResult {
  success: boolean
  tasks: { [key: string]: ExecuteTaskResult }
}

export interface ExecuteTaskResult {
  duration: number
  status: 'completed' | 'pending' | 'running' | 'failed' | 'canceled' | 'aborted'
  errorMessage?: string
  task: TaskNode
}

function replaceEnvVariables(
  baseEnv: { [key: string]: string },
  processEnv: { [key: string]: string | undefined }
): { [key: string]: string } {
  const result = { ...baseEnv }
  for (const key of Object.keys(result)) {
    const value = result[key]
    if (value.startsWith('$')) {
      const processEnvValue = processEnv[value.substr(1)]
      if (processEnvValue) {
        consola.debug(`use process env ${value.substr(1)}`)
        result[key] = processEnvValue
      } else {
        throw new Error(`missing env ${value}`)
      }
    }
  }
  return result
}

export function executeTask(
  build: ExecutionBuildFile,
  taskName: string,
  useCache: boolean,
  runArg: RunArg
): Promise<ExecuteResult> {
  const tree = plan(build, taskName)
  const depTree = restructure(tree, true)
  if (useCache) {
    optimize(depTree)
  }

  return execute(depTree, runArg)
}

export function execute(tree: TreeDependencies, arg: RunArg): Promise<ExecuteResult> {
  const runningTasks: TaskProcess[] = []
  const pendingTasks: TreeDependencyNode[] = []
  const watchingTasks: TaskProcess[] = []

  const result: ExecuteResult = {
    success: true,
    tasks: {},
  }
  for (const key of Object.keys(tree)) {
    consola.debug(`${tree[key].task.name} is pending for execution`)
    result.tasks[key] = { task: tree[key].task, duration: 0, status: 'pending' }
  }

  return new Promise<ExecuteResult>((resolve) => {
    moveRunningTasks()

    arg.cancelPromise.promise.then(() => {
      result.success = false
      for (const pendingTask of pendingTasks) {
        result.tasks[pendingTask.task.id].status = 'canceled'
      }
      for (const runningTask of runningTasks) {
        result.tasks[runningTask.task.id].status = 'aborted'
        result.tasks[runningTask.task.id].duration = new Date().getTime() - runningTask.start.getTime()
      }
      for (const watchingTask of watchingTasks) {
        result.tasks[watchingTask.task.id].status = 'aborted'
        result.tasks[watchingTask.task.id].duration = new Date().getTime() - watchingTask.start.getTime()
      }
      resolve(result)
    })

    function startWatchingTask(node: TreeDependencyNode) {
      let cancelPromise = new Defer<void>()

      function watchPromise(promise: Promise<any>): Promise<any> {
        return promise
          .then(() => {
            if (!cancelPromise.isResolved && !arg.cancelPromise.isResolved) {
              consola.info(`watched task ${node.task.name} ended early`)
            } else {
              consola.info(`watched task ${node.task.name} ended after cancellation`)
            }
          })
          .catch((err) => {
            if (!cancelPromise.isResolved && !arg.cancelPromise.isResolved) {
              consola.error(`watched task ${node.task.name} ended with error: ${err.message}`)
            }
          })
          .finally(() => {
            if (cancelPromise.isResolved) {
              cancelPromise = new Defer<void>()
              watchTask.promise = watchPromise(
                runTask(node.task, {
                  ...arg,
                  cancelPromise,
                })
              )
            }
          })
      }

      const watchTask: TaskProcess = {
        task: node.task,
        start: new Date(),
        promise: watchPromise(
          runTask(node.task, {
            ...arg,
            cancelPromise,
          })
        ),
      }

      for (const src of node.task.src) {
        consola.debug(`watch source ${src.absolutePath} for watched task ${node.task.name}`)
        watch(src.absolutePath, { recursive: true, persistent: false }, (type, fileName) => {
          const absoluteFileName = join(src.absolutePath, fileName)
          if (src.matcher(absoluteFileName, node.task.path)) {
            consola.debug(`source ${absoluteFileName} change for watched task ${node.task.name}`)
            cancelPromise.resolve()
          }
        })
      }
    }

    function moveRunningTasks() {
      if (arg.cancelPromise.isResolved) {
        return
      }

      for (const key of Object.keys(tree)) {
        const node = tree[key]
        if (node.dependencies.length === 0) {
          consola.debug(`${node.task.name} is scheduled for execution`)
          pendingTasks.push(node)
          delete tree[key]
        } else {
          consola.debug(`${node.task.name} requires ${node.dependencies.join(', ')} for execution`)
        }
      }

      for (let i = 0; i < pendingTasks.length; i++) {
        const pendingTask = pendingTasks[i]
        if (pendingTask.task.watch) {
          startWatchingTask(pendingTask)
          pendingTasks.splice(i, 1)
          i--
          continue
        }

        if (arg.workers !== 0 && runningTasks.length === arg.workers) {
          consola.debug(`${pendingTask.task.name} is postponed until a worker is available`)
          break
        }

        pendingTasks.splice(i, 1)
        i--

        const runningTask: TaskProcess = {
          task: pendingTask.task,
          start: new Date(),
          promise: runTask(pendingTask.task, arg),
        }
        consola.debug(`${pendingTask.task.name} is running`)
        runningTasks.push(runningTask)
        result.tasks[pendingTask.task.id].status = 'running'
        runningTask.promise
          .then(() => {
            result.tasks[pendingTask.task.id].status = 'completed'
            result.tasks[pendingTask.task.id].duration = new Date().getTime() - runningTask.start.getTime()
            consola.debug(`${pendingTask.task.name} completed in ${result.tasks[pendingTask.task.id].duration}ms`)
            writeCache(pendingTask)
            for (const key of Object.keys(tree)) {
              const index = tree[key].dependencies.indexOf(pendingTask.task.id)
              if (index >= 0) {
                tree[key].dependencies.splice(index, 1)
              }
            }
            runningTasks.splice(runningTasks.indexOf(runningTask), 1)
            moveRunningTasks()
          })
          .catch((err) => {
            result.success = false
            result.tasks[pendingTask.task.id].duration = new Date().getTime() - runningTask.start.getTime()
            result.tasks[pendingTask.task.id].status = 'failed'
            result.tasks[pendingTask.task.id].errorMessage = err.message
            consola.debug(
              `${pendingTask.task.name} failed in ${result.tasks[pendingTask.task.id].duration}ms with error ${
                err.message
              }`
            )
            runningTasks.splice(runningTasks.indexOf(runningTask), 1)
            resolve(result)
          })
      }

      if (pendingTasks.length === 0 && runningTasks.length === 0 && Object.keys(tree).length === 0) {
        if (watchingTasks.length > 0) {
          consola.info(`running watching tasks, press Ctrl-C to abort`)
        } else {
          consola.debug(
            `finished execution of tasks ${Object.keys(result.tasks).map((k) => result.tasks[k].task.name)}`
          )
          resolve(result)
        }
      }
    }
  })
}

function escapeCommand(cmd: string, envs: { [key: string]: string }) {
  let result = cmd
  for (const key of Object.keys(envs)) {
    const envValue = envs[key]
    result = result.replace(new RegExp(`\\$${key}`, 'gi'), envValue)
  }
  return result
}

async function runTask(task: TaskNode, arg: RunArg): Promise<void> {
  const envs = replaceEnvVariables(task.envs, arg.processEnvs)
  for (const cmd of task.cmds) {
    cmd.cmd = escapeCommand(cmd.cmd, envs)
  }
  if (task.image && !arg.noContainer) {
    await runTaskDocker(
      task.image,
      {
        ...task,
        envs,
      },
      arg
    )
  } else {
    if (task.image) {
      consola.debug(`${task.name} is executed locally instead inside of a container`)
    }

    await runLocally(
      {
        ...task,
        envs,
      },
      arg
    )
  }
}
