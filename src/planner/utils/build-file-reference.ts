import { BuildFile } from '../../parser/build-file'
import { WorkContext } from '../work-context'

export interface BuildFileReference {
  build: BuildFile
  name: string
  context: WorkContext
}
