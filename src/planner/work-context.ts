import { BuildFile } from '../parser/build-file'
import { WorkTree } from './work-tree'

export interface WorkContext {
  cwd: string
  namePrefix: string[]
  build: BuildFile
  workTree: WorkTree
}

export function createWorkContext(build: BuildFile): WorkContext {
  return {
    cwd: build.path,
    namePrefix: [],
    build,
    workTree: { nodes: {}, services: {} },
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
    cwd: options.type === 'references' ? subBuildFile.path : context.cwd,
    namePrefix: [...context.namePrefix, options.name],
  }
}
