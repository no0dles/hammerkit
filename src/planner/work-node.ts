import { WorkSource } from './work-source'
import { WorkCommand } from './work-command'
import { WorkService } from './work-service'
import { CacheMethod } from '../parser/cache-method'
import { LabelValues } from '../executer/label-values'
import { WorkMount } from './work-mount'
import { WorkVolume } from './work-volume'
import { ParseScope } from '../schema/parse-context'
import { WorkEnvironmentVariables } from '../environment/replace-env-variables'

export type WorkNode = LocalWorkNode | ContainerWorkNode

export interface BaseWorkNode {
  name: string
  cwd: string
  description: string | null
  src: WorkSource[]
  generates: WorkNodeGenerate[]
  envs: WorkEnvironmentVariables
  cmds: WorkCommand[]
  scope: ParseScope
  labels: LabelValues
  shell: string
  caching: CacheMethod | null
}

export interface WorkNodeGenerate {
  path: string
  volumeName: string
  inherited: boolean
  resetOnChange: boolean
  export: boolean
  isFile: boolean
}

export interface LocalWorkNode extends BaseWorkNode {
  type: 'local-task'
}

export interface ContainerWorkNode extends BaseWorkNode {
  type: 'container-task'
  image: string
  user: string | null
  mounts: WorkMount[]
  volumes: WorkVolume[]
}

export const isContainerWorkNode = (val: WorkNode | WorkService): val is ContainerWorkNode =>
  val.type === 'container-task'
export const isWorkNode = (val: WorkNode | WorkService): val is WorkNode =>
  val.type === 'container-task' || val.type === 'local-task'
