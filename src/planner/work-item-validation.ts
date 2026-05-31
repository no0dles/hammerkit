import { WorkTask } from './work-task'
import { WorkService } from './work-service'

export interface WorkItemValidation {
  item: WorkTask | WorkService
  message: string
  type: 'error' | 'warn'
}
