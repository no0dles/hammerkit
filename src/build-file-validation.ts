import { BuildFile } from './build-file'
import { Task } from './task'

export interface BuildFileValidation {
  buildFile: BuildFile
  task?: Task
  message: string
  type: 'error' | 'warn'
}
