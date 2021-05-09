import { restructure, TreeDependencies, TreeDependencyNode } from './2-restructure'
import { optimize, writeCache } from './3-optimize'
import { plan, TaskNode } from './1-plan'
import { RunArg } from '../run-arg'
import { runLocally } from './4-execute-local'
import { runTaskDocker } from './4-execute-docker'
import { ExecutionBuildFile } from './0-parse'
import consola from 'consola'

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
  status: 'completed' | 'pending' | 'running' | 'failed'
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
  const depTree = restructure(tree)
  if (useCache) {
    optimize(depTree)
  }
  return execute(depTree, runArg)
}

export function execute(tree: TreeDependencies, arg: RunArg): Promise<ExecuteResult> {
  const runningTasks: TaskProcess[] = []
  const pendingTasks: TreeDependencyNode[] = []
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

    function moveRunningTasks() {
      for (const key of Object.keys(tree)) {
        const node = tree[key]
        if (node.dependencies.length === 0) {
          consola.debug(`${node.task.name} is scheduled for execution`)
          pendingTasks.push(node)
          delete tree[key]
        }
      }

      for (let i = 0; i < pendingTasks.length; i++) {
        const pendingTask = pendingTasks[i]
        if (arg.workers !== 0 && runningTasks.length === arg.workers) {
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
        consola.debug(`finished execution of tasks ${Object.keys(result.tasks).map((k) => result.tasks[k].task.name)}`)
        resolve(result)
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
  if (task.image) {
    await runTaskDocker(
      task.image,
      {
        ...task,
        envs,
      },
      arg
    )
  } else {
    await runLocally(
      {
        ...task,
        envs,
      },
      arg
    )
  }
}
