import {restructure, TreeDependencies, TreeDependencyNode} from './2-restructure';
import {optimize, writeCache} from './3-optimize';
import {plan, TaskNode} from './1-plan';
import {RunArg} from '../run-arg';
import {runLocally} from './4-execute-local';
import {runTaskDocker} from './4-execute-docker';
import {ExecutionBuildFile} from './0-parse';

export interface TaskProcess {
  task: TaskNode
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

function replaceEnvVariables(baseEnv: { [key: string]: string }, processEnv: { [key: string]: string | undefined }): { [key: string]: string } {
  const result = {...baseEnv};
  for (const key of Object.keys(result)) {
    const value = result[key];
    if (value.startsWith('$')) {
      const processEnvValue = processEnv[value.substr(1)];
      if (processEnvValue) {
        result[key] = processEnvValue;
      } else {
        throw new Error(`missing env ${value}`);
      }
    }
  }
  return result;
}

export function executeTask(build: ExecutionBuildFile, taskName: string, useCache: boolean, runArg: RunArg): Promise<ExecuteResult> {
  const tree = plan(build, taskName);
  const depTree = restructure(tree);
  if (useCache) {
    optimize(depTree);
  }
  return execute(depTree, runArg);
}

export function execute(tree: TreeDependencies, arg: RunArg): Promise<ExecuteResult> {
  const runningTasks: TaskProcess[] = [];
  const pendingTasks: TreeDependencyNode[] = [];
  const result: ExecuteResult = {
    success: true,
    tasks: {},
  };
  for (const key of Object.keys(tree)) {
    result.tasks[key] = {task: tree[key].task, duration: 0, status: 'pending'};
  }

  return new Promise<ExecuteResult>((resolve, reject) => {
    moveRunningTasks();

    function moveRunningTasks() {
      for (const key of Object.keys(tree)) {
        const node = tree[key];
        if (node.dependencies.length === 0) {
          pendingTasks.push(node);
          delete tree[key];
        }
      }

      for (const pendingTask of pendingTasks) {
        if (arg.workers !== 0 && runningTasks.length === arg.workers) {
          break;
        }

        const runningTask: TaskProcess = {
          task: pendingTask.task,
          promise: runTask(pendingTask.task, arg),
        };
        result.tasks[pendingTask.task.id].status = 'running';
        runningTask.promise.then(() => {
          result.tasks[pendingTask.task.id].status = 'completed';
          writeCache(pendingTask);
          for (const key of Object.keys(tree)) {
            const index = tree[key].dependencies.indexOf(pendingTask.task.id);
            if (index >= 0) {
              tree[key].dependencies.splice(index, 1);
            }
          }
          runningTasks.splice(runningTasks.indexOf(runningTask), 1);
          moveRunningTasks();
        }).catch(err => {
          result.tasks[pendingTask.task.id].status = 'failed';
          result.tasks[pendingTask.task.id].errorMessage = err.message;
          runningTasks.splice(runningTasks.indexOf(runningTask), 1);
          resolve(result);
        });
        runningTasks.push(runningTask);
      }

      if (pendingTasks.length === 0 && runningTasks.length === 0 && Object.keys(tree).length === 0) {
        resolve(result);
      }
    }
  });
}

async function runTask(task: TaskNode, arg: RunArg): Promise<void> {
  const envs = replaceEnvVariables(task.envs, arg.processEnvs);
  if (task.image) {
    await runTaskDocker(task.image, {
      ...task,
      envs,
    }, arg);
  } else {
    await runLocally({
      ...task,
      envs,
    }, arg);
  }
}
