import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { NodeState } from '../executer/scheduler/node-state'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'

export async function expectSuccessfulResult(result: SchedulerResult, env: Environment): Promise<void> {
  if (!result.success) {
    for (const state of iterateWorkNodes(result.state.node)) {
      if (state.type !== 'completed') {
        expect({
          nodeId: state.itemId,
          status: state.type,
          updates: Array.from(state.node.status.read()).map((s) => `${s.level}: ${s.message}`),
          logs: Array.from(state.node.status.logs()).map((l) => `${l.console}: ${l.message}`),
          errorMessage: state.type === 'error' ? state.errorMessage : undefined,
          needs: state.node.needs.map((need) => ({
            name: need.name,
            updates: Array.from(need.service.status.read()).map((s) => `${s.level}: ${s.message}`),
            logs: Array.from(need.service.status.logs()).map((l) => `${l.console}: ${l.message}`),
          })),
        }).toEqual({
          nodeId: state.itemId,
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

function getNodeState(state: SchedulerState, name: string): NodeState {
  const node = Object.values(state.node).find((n) => n.node.name === name)
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
  const logs = Array.from(state.node.status.logs()).map((n) => n.message)
  expect(logs).toContain(message)
}
export async function expectContainsLog(
  result: SchedulerResult,
  env: Environment,
  name: string,
  message: string
): Promise<void> {
  const state = getNodeState(result.state, name)
  const logs = state.node.status.logs()
  for (const log of logs) {
    if (log.message.indexOf(message) >= 0) {
      return
    }
  }

  expect(Array.from(logs)).toContain(message)
}
