import { TaskNode } from './rewrite/1-plan'

export interface BuildFileValidation {
  task: TaskNode
  message: string
  type: 'error' | 'warn'
}
