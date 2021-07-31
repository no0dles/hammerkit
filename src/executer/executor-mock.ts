import { Executor } from './executor'
import { WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { Defer } from '../utils/defer'

export interface ExecutorMock extends Executor {
  waitFor(nodeId: string): Promise<Defer<void>>
}

export function getExecutorMock(): ExecutorMock {
  const waits: { [key: string]: Defer<Defer<void>> } = {}
  const execs: { [key: string]: Defer<void> } = {}

  return {
    exec(node: WorkNode, context: ExecutionContext, cancelDefer: Defer<void>): Promise<void> {
      const resultDefer = new Defer<void>()
      cancelDefer.promise.then(() => {
        resultDefer.reject(new Error('canceled'))
      })
      if (waits[node.id]) {
        waits[node.id].resolve(resultDefer)
        delete waits[node.id]
      } else {
        execs[node.id] = resultDefer
      }

      return resultDefer.promise
    },
    async waitFor(nodeId: string): Promise<Defer<void>> {
      const currentExecs = execs[nodeId]
      if (currentExecs) {
        delete execs[nodeId]
        return currentExecs
      }

      const resultDefer = new Defer<Defer<void>>()
      waits[nodeId] = resultDefer
      return resultDefer.promise
    },
  }
}
