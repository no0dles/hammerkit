import { BuildFile } from '../parser/build-file'
import { WorkNodeSource } from './work-node-source'
import { WorkNodeCommand } from './work-node-command'
import { WorkNodePath } from './work-node-path'
import { WorkNodePort } from './work-node-port'
import { WorkService } from './work-service'
import { CacheMethod } from '../parser/cache-method'
import { PlannedTask } from './utils/plan-work-node'
import { LabelValues } from '../executer/label-values'

export type WorkNode = LocalWorkNode | ContainerWorkNode

export interface BaseWorkNode {
  id: string
  taskName: string
  name: string
  cwd: string
  description: string | null
  continuous: boolean
  deps: WorkNode[]
  src: WorkNodeSource[]
  generates: { path: string; inherited: boolean }[]
  envs: { [key: string]: string }
  cmds: WorkNodeCommand[]
  plannedTask: PlannedTask
  buildFile: BuildFile
  needs: WorkService[]
  labels: LabelValues
  caching: CacheMethod | null
}

export interface LocalWorkNode extends BaseWorkNode {
  type: 'local'
}

export interface ContainerWorkNode extends BaseWorkNode {
  type: 'container'
  image: string
  shell: string
  mounts: WorkNodePath[]
  ports: WorkNodePort[]
}

export const isContainerWorkNode = (val: WorkNode): val is ContainerWorkNode => val.type === 'container'
