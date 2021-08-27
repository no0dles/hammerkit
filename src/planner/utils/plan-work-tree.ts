import { WorkTree } from '../work-tree'
import { BuildFile } from '../../parser/build-file'
import { WorkNodes } from '../work-nodes'
import { planWorkNode } from './plan-work-node'

export function planWorkTree(build: BuildFile, taskName: string): WorkTree {
  const nodes: WorkNodes = {}
  const rootNode = planWorkNode(build, taskName, nodes, { currentWorkdir: build.path, idPrefix: null, namePrefix: [] })
  return { nodes, rootNode }
}
