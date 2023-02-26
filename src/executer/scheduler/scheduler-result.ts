import { WorkTree } from '../../planner/work-tree'

export interface SchedulerResult {
  state: WorkTree
  success: boolean
}
