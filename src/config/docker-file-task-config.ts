import { TaskConfig } from './task-config'

export interface DockerFileTaskConfig extends TaskConfig {
  image: string
  shell?: string
  mounts?: string[]
}

export const isDockerFileTaskConfig = (val: TaskConfig): val is DockerFileTaskConfig => !!(<any>val).image
