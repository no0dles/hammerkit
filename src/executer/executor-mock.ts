import { Executor } from './executor'
import { WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'

export interface ExecutorMock extends Executor {
  waitForNode(nodeId: string): Promise<NodeHandle>
}

export interface NodeHandle {
  fail(err: Error): void;
  end(): void;
}

export function getExecutorMock(): ExecutorMock {
  const waits: { [key: string]: NodeHandle } = {}
  const execs: { [key: string]: NodeHandle } = {}

  return {
    restore(): Promise<void> {
      return Promise.resolve()
    },
    store(): Promise<void> {
      return Promise.resolve()
    },
    clean(): Promise<void> {
      return Promise.resolve()
    },
    exec(node: WorkNode, context: ExecutionContext, cancelDefer: AbortController): Promise<void> {
      return new Promise<void>((resolve, reject) => {
        const resultDefer: NodeHandle = {
          end() {
            resolve()
          },
          fail(err: Error) {
            reject(err)
          }
        }
        cancelDefer.promise.then(() => {
          if (resultDefer.isResolved) {
            return
          }
          resultDefer.reject(new Error('canceled'))
        })
        if (waits[node.id]) {
          waits[node.id].resolve(resultDefer)
          delete waits[node.id]
        } else {
          execs[node.id] = resultDefer
        }
      })
    },
    async waitForNode(nodeId: string): Promise<NodeHandle> {
      const currentExecs = execs[nodeId]
      if (currentExecs) {
        delete execs[nodeId]
        return currentExecs
      }

      const resultDefer: NodeHandle = {
        end() {
        },
        fail(err: Error) {
        }
      }
      waits[nodeId] = resultDefer
      return resultDefer
    },
  }
}
