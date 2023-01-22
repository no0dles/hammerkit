import { BuildFile } from '../parser/build-file'
import { WorkTree } from './work-tree'
import { WorkNodes } from './work-nodes'
import { WorkServices } from './work-services'

export interface WorkContext {
  cwd: string
  namePrefix: string[]
  build: BuildFile
  workTree: WorkTree
  nodes: WorkNodes
  services: WorkServices
}

export function createWorkContext(build: BuildFile): WorkContext {
  return {
    cwd: build.path,
    namePrefix: [],
    build,
    nodes: {},
    services: {},
    workTree: { nodes: {}, services: {}, environments: {} },
  }
}

export function createSubWorkContext(
  context: WorkContext,
  options: { name: string; type: 'references' | 'includes' }
): WorkContext {
  const subBuildFile = context.build[options.type][options.name]
  return {
    build: subBuildFile,
    workTree: context.workTree,
    services: context.services,
    nodes: context.nodes,
    cwd: options.type === 'references' ? subBuildFile.path : context.cwd,
    namePrefix: [...context.namePrefix, options.name],
  }
}
