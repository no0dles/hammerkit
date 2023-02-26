import { WorkSource } from './work-source'
import { WorkCommand } from './work-command'
import { WorkService } from './work-service'
import { CacheMethod } from '../parser/cache-method'
import { LabelValues } from '../executer/label-values'
import { WorkMount } from './work-mount'
import { WorkVolume } from './work-volume'
import { ParseScope } from '../schema/parse-context'
import { WorkEnvironmentVariables } from '../environment/replace-env-variables'

export type WorkTask = LocalWorkTask | ContainerWorkTask

export interface BaseWorkTask {
  name: string
  cwd: string
  description: string | null
  src: WorkSource[]
  generates: WorkTaskGenerate[]
  envs: WorkEnvironmentVariables
  cmds: WorkCommand[]
  scope: ParseScope
  labels: LabelValues
  shell: string
  caching: CacheMethod | null
}

export interface WorkTaskGenerate {
  path: string
  volumeName: string
  inherited: boolean
  resetOnChange: boolean
  export: boolean
  isFile: boolean
}

export interface LocalWorkTask extends BaseWorkTask {
  type: 'local-task'
}

export interface ContainerWorkTask extends BaseWorkTask {
  type: 'container-task'
  image: string
  user: string | null
  mounts: WorkMount[]
  volumes: WorkVolume[]
}

export const isContainerWorkTask = (val: WorkTask | WorkService): val is ContainerWorkTask =>
  val.type === 'container-task'
export const isWorkTask = (val: WorkTask | WorkService): val is WorkTask =>
  val.type === 'container-task' || val.type === 'local-task'
