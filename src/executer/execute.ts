import { WorkTree } from '../planner/work-tree'
import { ExecuteResult } from './execute-result'
import { RunArg } from '../run-arg'
import { optimize } from '../optimizer/optimize'
import { getReadyWorkNodes } from './get-ready-work-nodes'
import { WorkNode } from '../planner/work-node'
import { executeWorkNode } from './execute-work-node'
import { writeWorkNodeCache } from '../optimizer/write-work-node-cache'
import { watch } from 'fs'
import { join } from 'path'
import consola from 'consola'
import { isCompletedState, isRunningState, WorkNodeRunningState } from '../planner/work-node-status'
import { Defer } from '../defer'

export async function execute(workTree: WorkTree, arg: RunArg): Promise<ExecuteResult> {
  const runningNodes: WorkNode[] = []

  await optimize(workTree, arg)

  if (arg.watch) {
    watchNodes(workTree, runningNodes, arg)
  }
  runPendingNodes(workTree, runningNodes, arg)

  await workTree.rootNode.status.defer.promise

  const result: ExecuteResult = {
    success: true,
    nodes: {},
  }

  for (const nodeId of Object.keys(workTree.nodes)) {
    const node = workTree.nodes[nodeId]
    result.nodes[nodeId] = node.status.state
    if (node.status.state.type === 'failed') {
      result.success = false
    }
  }

  return result
}

function watchNodes(workTree: WorkTree, runningNodes: WorkNode[], arg: RunArg) {
  for (const nodeId of Object.keys(workTree.nodes)) {
    const node = workTree.nodes[nodeId]

    if (node.src.length === 0) {
      continue
    }

    for (const src of node.src) {
      const watcher = watch(src.absolutePath, { recursive: true, persistent: false }, (type, fileName) => {
        const absoluteFileName = join(src.absolutePath, fileName)
        if (src.matcher(absoluteFileName, node.path)) {
          consola.debug(`source ${absoluteFileName} change for watched task ${node.name}`)
          if (isRunningState(node.status.state)) {
            node.status.state.cancelDefer.resolve()
          } else if (isCompletedState(node.status.state)) {
            node.status.state = { type: 'pending' }
            for (const depNodeId of Object.keys(workTree.nodes)) {
              const depNode = workTree.nodes[depNodeId]
              const completedDepNode = depNode.status.completedDependencies[nodeId]
              if (completedDepNode) {
                depNode.status.pendingDependencies[nodeId] = completedDepNode
                delete depNode.status.completedDependencies[nodeId]
              }
            }
          }
          runPendingNodes(workTree, runningNodes, arg)
        }
      })

      arg.cancelPromise.promise.then(() => {
        watcher.close()
      })
    }
  }
}

function runPendingNodes(workTree: WorkTree, runningNodes: WorkNode[], arg: RunArg) {
  const pendingNodes = getReadyWorkNodes(workTree)
  for (const pendingNode of pendingNodes) {
    if (arg.workers !== 0 && runningNodes.length === arg.workers) {
      continue
    }

    runningNodes.push(pendingNode)

    continueExecution(workTree, runningNodes, pendingNode, arg)
  }
}

function getDuration(state: WorkNodeRunningState): number {
  return new Date().getTime() - state.started.getTime()
}

async function continueExecution(workTree: WorkTree, runningNodes: WorkNode[], node: WorkNode, arg: RunArg) {
  const runningState: WorkNodeRunningState = { type: 'running', started: new Date(), cancelDefer: new Defer<void>() }
  try {
    node.status.state = runningState
    await executeWorkNode(node, arg)
    node.status.state = { type: 'completed', ended: new Date(), duration: getDuration(runningState) }
    runningNodes.splice(runningNodes.indexOf(node), 1)

    for (const nodeId of Object.keys(workTree.nodes)) {
      const otherNode = workTree.nodes[nodeId]
      const dependency = otherNode.status.pendingDependencies[node.id]
      if (dependency) {
        delete otherNode.status.pendingDependencies[node.id]
        otherNode.status.completedDependencies[node.id] = dependency
      }
    }

    const cacheWrite = writeWorkNodeCache(node)

    if (!arg.watch) {
      cacheWrite.finally(() => {
        node.status.defer.resolve()
      })
    }

    runPendingNodes(workTree, runningNodes, arg)
  } catch (e) {
    node.status.state = { type: 'failed', ended: new Date(), duration: getDuration(runningState), error: e }
    node.status.defer.resolve()
    for (const nodeId of Object.keys(workTree.nodes)) {
      const otherNode = workTree.nodes[nodeId]
      if (otherNode.status.state.type === 'pending') {
        otherNode.status.state = { type: 'aborted' }
        otherNode.status.defer.resolve()
      } else if (otherNode.status.state.type === 'running') {
        otherNode.status.state.cancelDefer.resolve()
        otherNode.status.state = { type: 'aborted' }
        otherNode.status.defer.resolve()
      }
    }
  }
}
