import { WorkTree } from '../work-tree'
import { BuildFile } from '../../parser/build-file'
import { WorkNodes } from '../work-nodes'
import { planWorkNode } from './plan-work-node'
import { WorkServices } from '../work-services'
import { planWorkNodes } from './plan-work-nodes'
import { ExecTarget, isExecTargetTask } from '../../testing/test-suite'

export function planWorkTree(build: BuildFile, target: ExecTarget): WorkTree {
  if (isExecTargetTask(target)) {
    const nodes: WorkNodes = {}
    const services: WorkServices = {}
    const rootNode = planWorkNode(build, target.taskName, nodes, services, {
      currentWorkdir: build.path,
      idPrefix: null,
      namePrefix: [],
    })!
    return { nodes, rootNode, services }
  } else {
    const [nodes, services] = planWorkNodes(build, target)
    return { nodes, services }
  }
}
