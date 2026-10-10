import { BuildFileSchema } from './build-file-schema'
import { RefreshedGitSource, ResolvedGitSource } from '../includes/resolve-git-source'

export interface ParseContext {
  files: { [key: string]: ParseScope }
  // set by `includes pull`: git sources are fetched again instead of read from the
  // cache, once each, and recorded here
  refreshed?: Map<string, RefreshedGitSource>
}

export interface ParseScope {
  namePrefix: string
  schema: BuildFileSchema
  fileName: string
  cwd: string
  // set for a file that lives in a cached git checkout
  remote?: ResolvedGitSource
  // what the including file passed with `with`
  inputs?: NonNullable<BuildFileSchema['envs']>
  references: { [key: string]: { type: 'include' | 'reference'; scope: ParseScope } }
}
