import { BuildFileTask } from './build-file-task'
import { ExecutionBuildService } from './build-file-service'
import { BuildFileEnvironment } from './build-file-environment'

export interface BuildFile {
  fileName: string
  path: string
  envs: { [key: string]: string }
  tasks: { [key: string]: BuildFileTask }
  references: { [key: string]: BuildFile }
  includes: { [key: string]: BuildFile }
  services: { [key: string]: ExecutionBuildService }
  environments: { [key: string]: BuildFileEnvironment }
}
