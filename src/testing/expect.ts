import { ExecuteResult } from '../executer/execute-result'

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

export async function expectLog(result: ExecuteResult, nodeId: string, message: string): Promise<void> {
  const logs = await result.nodes[nodeId].console.read()
  expect(logs.map((l) => l.message)).toContain(message)
}
export async function expectContainsLog(result: ExecuteResult, nodeId: string, message: string): Promise<void> {
  const logs = await result.nodes[nodeId].console.read()
  expect(logs.some((l) => l.message.indexOf(message))).toBeTruthy()
}
