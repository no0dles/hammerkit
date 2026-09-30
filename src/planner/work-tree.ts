import { WorkEnvironment } from './work-environment'
import { WorkItemState } from './work-item'
import { WorkTask } from './work-task'
import { TaskState } from '../executer/scheduler/task-state'
import { WorkService } from './work-service'
import { ServiceState } from '../executer/scheduler/service-state'
import { CacheCatalog } from '../cache/resolve-cache'

export interface WorkTree {
  tasks: { [key: string]: WorkItemState<WorkTask, TaskState> }
  services: { [key: string]: WorkItemState<WorkService, ServiceState> }
  environment: WorkEnvironment
  // The resolved cache catalog (declared `caches:` merged with builtins). Used by
  // `cache pull`/`cache push` to select a backend by name (`--remote`), even one
  // no task references. Optional so synthetic/test work trees need not supply it.
  caches?: CacheCatalog
}
