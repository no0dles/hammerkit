import { SchedulerTerminationEvent } from '../executer/events'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { NodeState } from '../executer/scheduler/node-state'

export async function expectSuccessfulResult(result: SchedulerTerminationEvent): Promise<void> {
  if (!result.success) {
    for (const state of iterateWorkNodes(result.state.node)) {
      if (state.type === 'abort' || state.type === 'crash') {
        expect({
          nodeId: state.node.id,
          status: state.type,
          logs: await state.node.console.read(),
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

export async function expectLog(result: SchedulerTerminationEvent, name: string, message: string): Promise<void> {
  const state = getNodeState(result.state, name)
  const logs = await state.node.console.read()
  expect(logs.map((l) => l.message)).toContain(message)
}
export async function expectContainsLog(
  result: SchedulerTerminationEvent,
  name: string,
  message: string
): Promise<void> {
  const state = getNodeState(result.state, name)
  const logs = await state.node.console.read()
  expect(logs.some((l) => l.message.indexOf(message) >= 0)).toBeTruthy()
}
