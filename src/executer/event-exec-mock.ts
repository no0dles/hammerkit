import { HammerkitEvent } from './events'
import { ExecutionMock, ExecutionMockNode } from '../testing/test-suite'
import { getNode } from '../testing/get-node'
import { BuildFile } from '../parser/build-file'
import { Process } from './emitter'
import { sleep } from '../utils/sleep'
import { waitOnAbort } from '../utils/abort-event'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { Environment } from './environment'
import { WorkTree } from '../planner/work-tree'
import { Lazy } from '../testing/lazy'

class MockNode implements ExecutionMockNode {
  executeCount = 0
  exitCode = 0
  duration = 0

  set(options: { duration?: number; exitCode: number }): this {
    this.exitCode = options.exitCode
    this.duration = options.duration ?? 0
    return this
  }
}

export function getExecutionMock(
  buildFile: BuildFile,
  lazyWorkTree: Lazy<WorkTree>,
  environment: Environment
): ExecutionMock<HammerkitEvent> {
  const mockNodes: { [key: string]: MockNode } = {}

  const mock: ExecutionMock<HammerkitEvent> = {
    task(name: string): ExecutionMockNode {
      const node = getNode(buildFile, lazyWorkTree.resolve().nodes, name)
      const key = `node:${node.id}`
      const mockNode = mockNodes[key] ?? new MockNode()

      if (!mockNodes[key]) {
        mockNodes[key] = mockNode
      }

      return mockNode
    },
    getProcess(key: string): Process<HammerkitEvent, HammerkitEvent> | null {
      if (!mockNodes[key]) {
        mockNodes[key] = new MockNode()
      }

      const mockNode = mockNodes[key]

      if (key.startsWith('node') || key.startsWith('watch')) {
        const nodeId = key.substring(key.indexOf(':') + 1)
        const node = lazyWorkTree.resolve().nodes[nodeId]

        if (key.startsWith('watch')) {
          return null
        }

        return async () => {
          mockNode.executeCount++

          if (mockNode.duration > 0) {
            await sleep(mockNode.duration)
          }

          await writeWorkNodeCache(node, environment)

          if (mockNode.exitCode === 0) {
            return {
              type: 'node-completed',
              node,
            }
          } else {
            return {
              type: 'node-crash',
              node,
              command: 'mock',
              exitCode: mockNode.exitCode,
            }
          }
        }
      } else {
        const serviceId = key.substring('service:'.length)
        const service = lazyWorkTree.resolve().services[serviceId]

        return async (abort, emitter) => {
          if (mockNode.duration > 0) {
            await sleep(mockNode.duration)
          }

          emitter.emit({
            type: 'service-ready',
            service,
            dns: { containerId: '' },
          })

          await waitOnAbort(abort)

          return {
            type: 'service-canceled',
            service,
          }
        }
      }
    },
  }

  return mock
}
