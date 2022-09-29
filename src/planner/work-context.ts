import { WorkNode } from './work-node'
import { WorkService } from './work-service'

export interface WorkContext {
  currentWorkdir: string
  idPrefix: string | null
  namePrefix: string[]
}
