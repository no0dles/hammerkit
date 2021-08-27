import { ExecuteResult } from '../executer/execute-result'
import { WorkNodeStatus } from '../planner/work-node-status'

export async function expectSuccessfulResult(result: ExecuteResult): Promise<void> {
  if (!result.success) {
    for (const nodeId of Object.keys(result.nodes)) {
      const node = result.nodes[nodeId]
      if (node.state.type === 'failed') {
        expect({
          nodeId,
          status: node.state.type,
          logs: await node.console.read(),
        }).toEqual({
          nodeId,
          status: 'completed',
        })
      }
    }
  }
}

function getNode(result: ExecuteResult, name: string): WorkNodeStatus {
  const node = Object.values(result.nodes).find((n) => n.name === name)
  if (!node) {
    throw new Error(`could not find node ${name}`)
  }
  return node
}

export async function expectLog(result: ExecuteResult, name: string, message: string): Promise<void> {
  const node = getNode(result, name)
  const logs = await node.console.read()
  expect(logs.map((l) => l.message)).toContain(message)
}
export async function expectContainsLog(result: ExecuteResult, name: string, message: string): Promise<void> {
  const node = getNode(result, name)
  const logs = await node.console.read()
  expect(logs.some((l) => l.message.indexOf(message))).toBeTruthy()
}
