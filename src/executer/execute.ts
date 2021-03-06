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
import { listenOnAbort } from '../utils/abort-event'

export async function execute(workTree: WorkTree, context: ExecutionContext): Promise<ExecuteResult> {
  listenOnAbort(context.environment.abortCtrl.signal, () => {
    cancelNodes(workTree, context)
  })

  await optimize(workTree, context)

  if (context.watch) {
    await watchNodes(workTree, context)
  }

  await run(workTree, context)

  const result: ExecuteResult = {
    success: true,
    nodes: {},
  }

  for (const node of iterateWorkNodes(workTree.nodes)) {
    result.nodes[node.id] = node.status
    if (node.status.state.type === 'failed' || node.status.state.type === 'aborted') {
      result.success = false
    }
  }

  return result
}

export function run(workTree: WorkTree, context: ExecutionContext): Promise<void> {
  const runningNodes: { [id: string]: WorkNode } = {}
  const pendingNodeIds: string[] = []

  return new Promise<void>((resolve, reject) => {
    listenOnAbort(context.environment.abortCtrl.signal, () => {
      let hasRunningNode = false
      for (const node of iterateWorkNodes(workTree.nodes)) {
        if (
          node.status.state.type === 'cancel' ||
          node.status.state.type === 'pending' ||
          node.status.state.type === 'running'
        ) {
          hasRunningNode = true
          break
        }
      }
      if (!hasRunningNode) {
        resolve()
      }
    })

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
        failNode(workTree, node.id, context, e)
      }
    }

    const enqueueNode = async (node: WorkNode) => {
      try {
        if (node.status.state.type === 'pending') {
          if (Object.keys(node.status.state.pendingDependencies).length !== 0) {
            return
          }

          pendingNodeIds.push(node.id)

          await runPending()
        } else if (
          (!context.watch || context.environment.abortCtrl.signal.aborted) &&
          (workTree.rootNode.status.state.type === 'completed' ||
            workTree.rootNode.status.state.type === 'aborted' ||
            workTree.rootNode.status.state.type === 'failed')
        ) {
          resolve()
        }
      } catch (e) {
        reject(e)
      }
    }

    context.events.on((evt) => {
      const node = workTree.nodes[evt.nodeId]
      enqueueNode(node)
    })

    for (const node of iterateWorkNodes(workTree.nodes)) {
      enqueueNode(node)
    }
  })
}

async function watchNodes(workTree: WorkTree, context: ExecutionContext) {
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
      listenOnAbort(context.environment.abortCtrl.signal, () => {
        watcher.close()
        debouncer.clear()
      })
    }
  }
}
