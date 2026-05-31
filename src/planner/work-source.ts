import { WorkItem } from './work-item'
import { WorkTask } from './work-task'
import { WorkService } from './work-service'

export interface WorkSource {
  absolutePath: string
  source: string
  matcher: (fileName: string, cwd: string) => boolean
  inherited: WorkItem<WorkTask | WorkService> | null
  isFile: boolean
}
