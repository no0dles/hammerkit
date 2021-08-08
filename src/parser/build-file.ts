import { BuildFileTask } from './build-file-task'
import { BuildFileContainerRuntime } from './build-file-container-runtime'

export interface BuildFile {
  fileName: string
  path: string
  containerRuntime: BuildFileContainerRuntime
  envs: { [key: string]: string }
  tasks: { [key: string]: BuildFileTask }
  references: { [key: string]: BuildFile }
  includes: { [key: string]: BuildFile }
}
