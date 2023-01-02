import { WorkNode } from './work-node'
import { WorkService } from './work-service'

export interface WorkNodeValidation {
  node: WorkNode | WorkService
  message: string
  type: 'error' | 'warn'
}
