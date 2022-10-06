import { BuildFile } from '../parser/build-file'
import { WorkTree } from './work-tree'
import { CacheMethod } from '../parser/cache-method'

export interface WorkContext {
  cwd: string
  // idPrefix: string | null
  namePrefix: string[]
  build: BuildFile
  workTree: WorkTree
  cacheDefault: CacheMethod
}

export function createWorkContext(build: BuildFile, cacheDefault: CacheMethod | null): WorkContext {
  return {
    cwd: build.path,
    // idPrefix: null,
    namePrefix: [],
    build,
    workTree: { nodes: {}, services: {} },
    cacheDefault: cacheDefault ?? 'checksum',
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
    // idPrefix: null,
    namePrefix: [...context.namePrefix, options.name],
    cacheDefault: context.cacheDefault,
  }
}
