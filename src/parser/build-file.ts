import { BuildFileTask } from './build-file-task'

export interface BuildFile {
  fileName: string
  path: string
  envs: { [key: string]: string }
  tasks: { [key: string]: BuildFileTask }
  references: { [key: string]: BuildFile }
  includes: { [key: string]: BuildFile }
}
