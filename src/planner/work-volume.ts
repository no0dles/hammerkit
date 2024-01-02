import { WorkService } from './work-service'
import { WorkItem } from './work-item'
import { WorkTask } from './work-task'

export interface WorkVolume {
  name: string
  containerPath: string
  resetOnChange: boolean
  inherited: WorkItem<WorkService | WorkTask> | null
  export: boolean
}
