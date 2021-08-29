import { BuildFile } from '../../parser/build-file'
import { WorkNodes } from '../work-nodes'
import { planWorkNode } from './plan-work-node'
import { WorkNode } from '../work-node'
import { WorkServices } from '../work-services'

export function planWorkNodes(build: BuildFile): [WorkNodes, WorkServices] {
  const nodes: WorkNodes = {}
  const services: WorkServices = {}
  addWorkNodes(build, nodes, services, [], [])
  return [nodes, services]
}

export function* iterateWorkNodes(nodes: WorkNodes): Generator<WorkNode> {
  for (const nodeId of Object.keys(nodes)) {
    const node = nodes[nodeId]
    yield node
  }
}

function addWorkNodes(
  build: BuildFile,
  nodes: WorkNodes,
  services: WorkServices,
  files: string[],
  namePrefix: string[]
) {
  if (files.indexOf(build.fileName) !== -1) {
    return
  }

  files.push(build.fileName)
  for (const taskId of Object.keys(build.tasks)) {
    planWorkNode(build, taskId, nodes, services, { currentWorkdir: build.path, idPrefix: null, namePrefix: namePrefix })
  }

  for (const key of Object.keys(build.references)) {
    addWorkNodes(build.references[key], nodes, services, files, [...namePrefix, key])
  }

  for (const key of Object.keys(build.includes)) {
    addWorkNodes(build.includes[key], nodes, services, files, [...namePrefix, key])
  }
}
