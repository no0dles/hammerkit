import { BuildFileSchema } from './build-file-schema'

export interface ParseContext {
  files: { [key: string]: ParseScope }
}

export interface ParseScope {
  namePrefix: string
  schema: BuildFileSchema
  fileName: string
  cwd: string
  references: { [key: string]: { type: 'include' | 'reference'; scope: ParseScope } }
}
