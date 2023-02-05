import { WorkService } from './work-service'
import { WorkItem } from './work-item'

export interface WorkServices {
  [key: string]: WorkItem<WorkService>
}
