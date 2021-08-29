import { Executor, ServiceProcess } from './executor'
import { WorkNode } from '../planner/work-node'
import { ExecutionContext } from './execution-context'
import { listenOnAbort } from '../utils/abort-event'
import { WorkService } from '../planner/work-service'
import { Environment } from './environment'
import { WorkTree } from '../planner/work-tree'

export interface ExecutorMock extends Executor {
  waitForExecution(nodeId: string): Promise<NodeHandle>

  abort(nodeId: string, err: Error): void

  end(nodeId: string): void
}

export interface NodeHandle {
  fail(err: Error): void

  end(): void
}

export function getExecutorMock(): ExecutorMock {
  const waits: { [key: string]: (handle: NodeHandle) => void } = {}
  const execs: { [key: string]: NodeHandle } = {}

  return {
    start(workTree: WorkTree, service: WorkService, context: ExecutionContext): ServiceProcess {
      return {
        async stop(): Promise<void> {}, // TODO
      }
    },
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
            delete execs[node.id]
            resolve()
          },
          fail(err: Error) {
            delete execs[node.id]
            reject(err)
          },
        }
        listenOnAbort(cancelDefer.signal, () => {
          reject(new Error('canceled'))
        })
        if (waits[node.id]) {
          waits[node.id](resultDefer)
          delete waits[node.id]
        } else {
          execs[node.id] = resultDefer
        }
      })
    },
    abort(nodeId: string, err: Error): void {
      execs[nodeId].fail(err)
    },
    end(nodeId: string): void {
      execs[nodeId].end()
    },
    async waitForExecution(nodeId: string): Promise<NodeHandle> {
      const currentExecs = execs[nodeId]
      if (currentExecs) {
        return currentExecs
      }

      const promise = new Promise<NodeHandle>((resolve) => {
        waits[nodeId] = resolve
      })

      return promise
    },
  }
}
