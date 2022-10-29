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
          nodeId: state.node.id,
          status: state.type,
          logs: env.status.task(state.node).read(),
          errorMessage: state.type === 'error' ? state.errorMessage : undefined,
        }).toEqual({
          nodeId: state.node.id,
          status: 'completed',
        })
      }
    }
  }
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
  const logs = env.status.task(state.node).read()
  expect(logs).toContain(message)
}
export async function expectContainsLog(
  result: SchedulerResult,
  env: Environment,
  name: string,
  message: string
): Promise<void> {
  const state = getNodeState(result.state, name)
  const logs = env.status.task(state.node).read()
  for (const log of logs) {
    if (log.message.indexOf(message) >= 0) {
      return
    }
  }

  expect(Array.from(logs)).toContain(message)
}
