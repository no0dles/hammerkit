import { BuildFileSchema } from './build-file-schema'
import { ResolvedGitSource } from '../includes/resolve-git-source'

export interface ParseContext {
  files: { [key: string]: ParseScope }
}

export interface ParseScope {
  namePrefix: string
  schema: BuildFileSchema
  fileName: string
  cwd: string
  // set for a file that lives in a cached git checkout
  remote?: ResolvedGitSource
  references: { [key: string]: { type: 'include' | 'reference'; scope: ParseScope } }
}
