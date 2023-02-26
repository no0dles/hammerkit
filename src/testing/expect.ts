import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { NodeState } from '../executer/scheduler/node-state'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'
import { WorkTree } from '../planner/work-tree'
import { WorkItemState } from '../planner/work-item'
import { WorkNode } from '../planner/work-node'
import { CliExecResult } from '../cli'
import { getSchedulerExecuteResult } from '../executer/get-scheduler-execute-result'

export async function expectSuccessfulExecution(exec: CliExecResult, env: Environment): Promise<void> {
  const badResult = new Promise<SchedulerResult>((resolve) => {
    exec.state.on('expected-status', (workTree) => {
      if (env.abortCtrl.signal.aborted) {
        return
      }

      const hasErrorNode = Object.values(workTree.nodes).some(
        (n) => n.state.current.type === 'error' || n.state.current.type === 'crash'
      )
      const hasErrorService = Object.values(workTree.services).some(
        (n) => n.state.current.type === 'error' || n.state.current.type === 'end'
      )
      if (!hasErrorNode && !hasErrorService) {
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
    for (const node of iterateWorkNodes(result.state)) {
      if (node.state.current.type !== 'completed') {
        expect({
          nodeId: node.id,
          status: node.state.current.type,
          updates: Array.from(node.status.read()).map((s) => `${s.level}: ${s.message}`),
          logs: Array.from(node.status.logs()).map((l) => `${l.console}: ${l.message}`),
          errorMessage: node.state.current.type === 'error' ? node.state.current.errorMessage : undefined,
          needs: node.needs.map((need) => ({
            name: need.name,
            updates: Array.from(need.service.status.read()).map((s) => `${s.level}: ${s.message}`),
            logs: Array.from(need.service.status.logs()).map((l) => `${l.console}: ${l.message}`),
          })),
        }).toEqual({
          nodeId: node.id,
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

function getNodeState(state: WorkTree, name: string): WorkItemState<WorkNode, NodeState> {
  const node = Object.values(state.nodes).find((n) => n.name === name)
  if (!node) {
    throw new Error(`could not find node ${name}`)
  }
  return node
}

export async function expectLog(
  result: SchedulerResult,
  env: Environment,
  name: string,
  message: string
): Promise<void> {
  const state = getNodeState(result.state, name)
  const logs = Array.from(state.status.logs()).map((n) => n.message)
  expect(logs).toContain(message)
}
export async function expectContainsLog(
  result: SchedulerResult,
  env: Environment,
  name: string,
  message: string
): Promise<void> {
  const state = getNodeState(result.state, name)
  const logs = state.status.logs()
  for (const log of logs) {
    if (log.message.indexOf(message) >= 0) {
      return
    }
  }

  expect(Array.from(logs)).toContain(message)
}
