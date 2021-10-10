import { WorkTree } from '../planner/work-tree'
import { ExecuteResult } from './execute-result'
import { optimize } from '../optimizer/optimize'
import { WorkNode } from '../planner/work-node'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { join } from 'path'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { cancelNodes, completeNode, failNode, resetNode, runNode } from './states'
import { ExecutionContext } from './execution-context'
import { Debouncer } from '../utils/debouncer'
import { hasStatsChanged, getWorkNodeCacheStats } from '../optimizer/get-work-node-cache-stats'
import { ServiceProcess } from './executor'
import { getErrorMessage } from '../log'
import { logMessageToConsole } from '../logging/message-to-console'
import { abortableFunction, AbortableFunctionContext } from '../utils/abortable-function'

export async function execute(workTree: WorkTree, context: ExecutionContext): Promise<ExecuteResult> {
  const result: ExecuteResult = {
    success: true,
    nodes: {},
  }

  try {
    await abortableFunction<void>(context.environment.console, context.environment.abortCtrl.signal, async (ctx) => {
      ctx.addAbortFunction(() => {
        cancelNodes(workTree, context)
      })

      await optimize(workTree, context)
      await context.executor.prepareRun(workTree.nodes, workTree.services)

      if (context.watch) {
        await watchNodes(workTree, context, ctx)
      }

      await run(workTree, context, ctx)
    })
  } catch (e) {
    context.environment.console.error(`execution failed: ${getErrorMessage(e)}`)
  } finally {
    for (const node of iterateWorkNodes(workTree.nodes)) {
      result.nodes[node.id] = node.status
      if (node.status.state.type === 'failed' || node.status.state.type === 'aborted') {
        result.success = false
      }
    }
  }

  return result
}

export function run(
  workTree: WorkTree,
  context: ExecutionContext,
  abortContext: AbortableFunctionContext
): Promise<void> {
  const runningNodes: { [id: string]: WorkNode } = {}
  const runningServices: { [id: string]: ServiceProcess } = {}
  const pendingNodeIds: string[] = []
  const runningNodePromises: Promise<void>[] = []

  return new Promise<void>((resolve, reject) => {
    abortContext.addAbortFunction(async () => {
      await Promise.allSettled(runningNodePromises)
      await shutdown()
    })

    const shutdown = async (error?: unknown) => {
      for (const svc of Object.values(runningServices)) {
        try {
          await svc.stop()
        } catch (e) {
          logMessageToConsole(
            {
              type: 'internal',
              message: `unable to stop service ${svc.name}`,
              level: 'warn',
              date: new Date(),
            },
            { type: 'general' }
          )
        }
      }

      if (error) {
        reject(error)
      } else {
        resolve()
      }
    }

    const runPending = async () => {
      if (context.workers !== 0 && Object.keys(runningNodes).length >= context.workers) {
        return
      }

      const nextNodeId = pendingNodeIds.splice(0, 1)[0]
      if (!nextNodeId) {
        return
      }

      const node = workTree.nodes[nextNodeId]
      runningNodes[nextNodeId] = node

      const abortCtrl = runNode(workTree, node.id, context)
      try {
        await context.executor.exec(node, context, abortCtrl)
        await writeWorkNodeCache(node, context.environment)
        delete runningNodes[nextNodeId]
        completeNode(workTree, node.id, context)
      } catch (e) {
        delete runningNodes[nextNodeId]
        failNode(workTree, node.id, context, getErrorMessage(e))
      }
    }

    const enqueueNode = (node: WorkNode) => {
      try {
        if (node.status.state.type === 'pending') {
          if (Object.keys(node.status.state.pendingDependencies).length !== 0) {
            return
          }

          if (Object.keys(node.status.state.pendingServices).length !== 0) {
            for (const need of node.needs) {
              if (runningServices[need.id]) {
                continue
              }
              runningServices[need.id] = context.executor.start(workTree, need, context)
            }
            return
          }

          pendingNodeIds.push(node.id)

          runningNodePromises.push(runPending())
        } else if (
          (!context.watch || context.environment.abortCtrl.signal.aborted) &&
          (workTree.rootNode.status.state.type === 'completed' ||
            workTree.rootNode.status.state.type === 'aborted' ||
            workTree.rootNode.status.state.type === 'failed')
        ) {
          shutdown()
        }
      } catch (e) {
        shutdown(e)
      }
    }

    context.events.on((evt) => {
      if (evt.type === 'node') {
        const node = workTree.nodes[evt.nodeId]
        enqueueNode(node)
      } else {
        //TODO remove service if not needed
      }
    })

    for (const node of iterateWorkNodes(workTree.nodes)) {
      enqueueNode(node)
    }
  })
}

async function watchNodes(workTree: WorkTree, context: ExecutionContext, abortContext: AbortableFunctionContext) {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    if (node.src.length === 0) {
      continue
    }

    let currentState = await getWorkNodeCacheStats(node, context.environment)

    const debouncer = new Debouncer(async () => {
      if (context.environment.abortCtrl.signal.aborted) {
        return
      }

      const newStats = await getWorkNodeCacheStats(node, context.environment)
      const hasChanged = await hasStatsChanged(node, currentState, newStats, context.cacheMethod)
      if (!hasChanged) {
        return
      }
      currentState = newStats

      node.status.console.write('internal', 'debug', `source changed, restart process`)
      resetNode(workTree, node.id, context)
    }, 100)

    for (const src of node.src) {
      node.status.console.write('internal', 'debug', `watch ${src.absolutePath} source`)
      const watcher = context.environment.file.watch(src.absolutePath, async (fileName) => {
        const absoluteFileName = join(src.absolutePath, fileName)

        if (src.matcher(absoluteFileName, node.cwd)) {
          node.status.console.write(
            'internal',
            'debug',
            `source ${absoluteFileName} change for watched task ${node.name}`
          )
          debouncer.bounce()
        }
      })
      abortContext.addAbortFunction(() => {
        watcher.close()
        debouncer.clear()
      })
    }
  }
}
