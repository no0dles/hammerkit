import { BuildFile } from '../../parser/build-file'
import { WorkNodes } from '../work-nodes'
import { planWorkNode } from './plan-work-node'
import { WorkNode } from '../work-node'

export function planWorkNodes(build: BuildFile): WorkNodes {
  const nodes: WorkNodes = {}
  addWorkNodes(build, nodes, [], [])
  return nodes
}

export function* iterateWorkNodes(nodes: WorkNodes): Generator<WorkNode> {
  for (const nodeId of Object.keys(nodes)) {
    const node = nodes[nodeId]
    yield node
  }
}

function addWorkNodes(build: BuildFile, nodes: WorkNodes, files: string[], namePrefix: string[]) {
  if (files.indexOf(build.fileName) !== -1) {
    return
  }

  files.push(build.fileName)
  for (const taskId of Object.keys(build.tasks)) {
    planWorkNode(build, taskId, nodes, { currentWorkdir: build.path, idPrefix: null, namePrefix: namePrefix })
  }

  for (const key of Object.keys(build.references)) {
    addWorkNodes(build.references[key], nodes, files, [...namePrefix, key])
  }

  for (const key of Object.keys(build.includes)) {
    addWorkNodes(build.includes[key], nodes, files, [...namePrefix, key])
  }
}
