import { BuildFile } from './build-file'

export interface BuildFileReference {
  name: string
  buildFile: BuildFile
  type: 'include' | 'reference'
}
