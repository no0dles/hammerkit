import { WorkNode } from './work-node'

export interface WorkNodeValidation {
  node: WorkNode
  message: string
  type: 'error' | 'warn'
}
