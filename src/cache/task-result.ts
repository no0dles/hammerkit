import { TaskGeneration } from './task-generation'

export interface TaskResult {
  cached: boolean
  generations: TaskGeneration[]
}
