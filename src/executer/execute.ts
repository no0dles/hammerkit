import { WorkTree } from '../planner/work-tree'
import { ExecuteResult } from './execute-result'
import { optimize } from '../optimizer/optimize'
import { getReadyWorkNodes } from './get-ready-work-nodes'
import { WorkNode } from '../planner/work-node'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { join } from 'path'
import { iterateWorkNodes } from '../planner/utils/plan-work-nodes'
import { cancelNodes, completeNode, failNode, resetNode, runNode } from './states'
import { ExecutionContext } from './execution-context'
import { Debouncer } from '../utils/debouncer'
import { hasStatsChanged, getWorkNodeCacheStats } from '../optimizer/get-work-node-cache-stats'

export async function execute(workTree: WorkTree, context: ExecutionContext): Promise<ExecuteResult> {
  context.environment.cancelDefer.promise.then(() => {
    cancelNodes(workTree, context)
  })

  await optimize(workTree, context)

  if (context.watch) {
    await watchNodes(workTree, context)
  }

  runPendingNodes(workTree, context)

  await workTree.rootNode.status.defer.promise
  for (const node of iterateWorkNodes(workTree.nodes)) {
    await node.status.defer.promise
  }

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

async function watchNodes(workTree: WorkTree, context: ExecutionContext) {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    if (node.src.length === 0) {
      continue
    }

    let currentState = await getWorkNodeCacheStats(node, context.environment)

    const debouncer = new Debouncer(async () => {
      if (context.environment.cancelDefer.signal.aborted) {
        return
      }

      const newStats = await getWorkNodeCacheStats(node, context.environment)
      const hasChanged = await hasStatsChanged(node, currentState, newStats, context.cacheMethod)
      if (!hasChanged) {
        return
      }
      currentState = newStats

      resetNode(workTree, node.id, context)
      runPendingNodes(workTree, context)
    }, 100)

    for (const src of node.src) {
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

      context.environment.cancelDefer.promise.then(() => {
        watcher.close()
      })
    }
  }
}

function runPendingNodes(workTree: WorkTree, arg: ExecutionContext) {
  const pendingNodes = getReadyWorkNodes(workTree)
  for (const pendingNode of pendingNodes) {
    if (arg.workers !== 0 && Object.keys(arg.runningNodes).length === arg.workers) {
      continue
    }

    if (arg.runningNodes[pendingNode.id]) {
      continue
    }

    continueExecution(workTree, pendingNode, arg)
  }
}

async function continueExecution(workTree: WorkTree, node: WorkNode, context: ExecutionContext) {
  const cancelDefer = runNode(workTree, node.id, context)
  try {
    await context.executor.exec(node, context, cancelDefer)
    await writeWorkNodeCache(node, context.environment)
    completeNode(workTree, node.id, context, true)
  } catch (e) {
    failNode(workTree, node.id, context, e)
  }
  runPendingNodes(workTree, context)
}
