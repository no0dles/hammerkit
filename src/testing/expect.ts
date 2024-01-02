import { iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { TaskState } from '../executer/scheduler/task-state'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'
import { WorkItemState } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'
import { CliExecResult } from '../cli'
import { getSchedulerExecuteResult } from '../executer/get-scheduler-execute-result'

export async function expectSuccessfulExecution(exec: CliExecResult, env: Environment): Promise<void> {
  const badResult = new Promise<SchedulerResult>((resolve) => {
    exec.state.on('expected-status', (workTree) => {
      if (env.abortCtrl.signal.aborted) {
        return
      }

      const hasErrorTask = Object.values(workTree.tasks).some(
        (n) => n.state.current.type === 'error' || n.state.current.type === 'crash'
      )
      const hasErrorService = Object.values(workTree.services).some(
        (n) => n.state.current.type === 'error' || n.state.current.type === 'end'
      )
      if (!hasErrorTask && !hasErrorService) {
        return
      }

      const stateResult = getSchedulerExecuteResult(workTree)
      if (!stateResult.success) {
        resolve(stateResult)
        env.abortCtrl.abort()
      }
    })
  })
  const result = await Promise.race([badResult, exec.start()])
  await expectSuccessfulResult(result, env)
}

export async function expectSuccessfulResult(result: SchedulerResult, env: Environment): Promise<void> {
  if (!result.success) {
    for (const task of iterateWorkTasks(result.state)) {
      if (task.state.current.type !== 'completed') {
        expect({
          cacheId: task.id(),
          status: task.state.current.type,
          updates: Array.from(task.status.read()).map((s) => `${s.level}: ${s.message}`),
          logs: Array.from(task.status.logs()).map((l) => `${l.console}: ${l.message}`),
          errorMessage: task.state.current.type === 'error' ? task.state.current.errorMessage : undefined,
          needs: task.needs.map((need) => ({
            name: need.name,
            updates: Array.from(need.service.status.read()).map((s) => `${s.level}: ${s.message}`),
            logs: Array.from(need.service.status.logs()).map((l) => `${l.console}: ${l.message}`),
          })),
        }).toEqual({
          cacheId: task.id(),
          status: 'completed',
        })
      }
    }
  }
  const status = Array.from(env.status.read())
  const errorStatus = status
    .filter((s) => s.level === 'warn' || s.level === 'error')
    .map((s) => `${s.context.type}:${s.context.name} - ${s.level} ${s.message}`)
  expect(errorStatus).toEqual([])
}

function getTaskState(state: WorkTree, name: string): WorkItemState<WorkTask, TaskState> {
  const tasks = Object.values(state.tasks).find((n) => n.name === name)
  if (!tasks) {
    throw new Error(`could not find task ${name}`)
  }
  return tasks
}

export async function expectLog(
  result: SchedulerResult,
  env: Environment,
  name: string,
  message: string
): Promise<void> {
  const state = getTaskState(result.state, name)
  const logs = Array.from(state.status.logs()).map((n) => n.message)
  expect(logs).toContain(message)
}
export async function expectContainsLog(
  result: SchedulerResult,
  env: Environment,
  name: string,
  message: string
): Promise<void> {
  const state = getTaskState(result.state, name)
  const logs = state.status.logs()
  for (const log of logs) {
    if (log.message.indexOf(message) >= 0) {
      return
    }
  }

  expect(Array.from(logs)).toContain(message)
}
