import { WorkItem } from './work-item'
import { WorkTask } from './work-task'
import { WorkService } from './work-service'

export interface WorkSource {
  absolutePath: string
  source: string
  // With `partial`, fileName is a directory and the question is whether files
  // inside it can match — used to decide which directories to walk.
  matcher: (fileName: string, cwd: string, partial?: boolean) => boolean
  inherited: WorkItem<WorkTask | WorkService> | null
  isFile: boolean
}
