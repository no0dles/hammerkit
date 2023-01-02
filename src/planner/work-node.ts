import { BuildFile } from '../parser/build-file'
import { WorkNodeSource } from './work-node-source'
import { WorkNodeCommand } from './work-node-command'
import { WorkNodePort } from './work-node-port'
import { WorkService } from './work-service'
import { CacheMethod } from '../parser/cache-method'
import { PlannedTask } from './utils/plan-work-node'
import { LabelValues } from '../executer/label-values'
import { WorkMount } from './work-mount'
import { WorkVolume } from './work-volume'

export type WorkNode = LocalWorkNode | ContainerWorkNode

export interface BaseWorkNode {
  id: string
  taskName: string
  name: string
  cwd: string
  continuous: boolean
  description: string | null
  deps: WorkNode[]
  src: WorkNodeSource[]
  generates: WorkNodeGenerate[]
  envs: { [key: string]: string }
  cmds: WorkNodeCommand[]
  plannedTask: PlannedTask
  buildFile: BuildFile
  needs: WorkService[]
  labels: LabelValues
  caching: CacheMethod | null
}

export interface WorkNodeGenerate {
  path: string
  inherited: boolean
  resetOnChange: boolean
}

export interface LocalWorkNode extends BaseWorkNode {
  type: 'local'
}

export interface ContainerWorkNode extends BaseWorkNode {
  type: 'container'
  image: string
  shell: string
  user: string | null
  mounts: WorkMount[]
  ports: WorkNodePort[]
  volumes: WorkVolume[]
}

export const isContainerWorkNode = (val: WorkNode | WorkService): val is ContainerWorkNode => val.type === 'container'
export const isWorkNode = (val: WorkNode | WorkService): val is WorkNode =>
  val.type === 'container' || val.type === 'local'
