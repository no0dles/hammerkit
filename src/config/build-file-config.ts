import { TaskConfig } from './task-config'
import { DockerFileTaskConfig } from './docker-file-task-config'

export interface BuildFileConfig {
  envs?: { [key: string]: string }
  tasks?: { [key: string]: TaskConfig | DockerFileTaskConfig }
  includes?: { [key: string]: string }
  references?: { [key: string]: string }
}
