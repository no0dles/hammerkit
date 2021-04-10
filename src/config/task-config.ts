import { TaskCommandConfig } from './task-command-config'

export interface TaskConfig {
  description?: string
  cmds?: TaskCommandConfig[]
  deps?: string[]
  src?: string[]
  generates?: string[]
  envs?: { [key: string]: string }
}
