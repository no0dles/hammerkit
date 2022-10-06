import { BuildFile } from '../parser/build-file'
import { WorkNodeSource } from './work-node-source'
import { WorkNodeCommand } from './work-node-command'
import { WorkNodePath } from './work-node-path'
import { WorkNodePort } from './work-node-port'
import { WorkService } from './work-service'
import { StatusConsole, LogConsole } from './work-node-status'
import { LabelValues } from '../testing/test-suite'
import { CacheMethod } from '../parser/cache-method'
import { PlannedTask } from './utils/plan-work-node'

export type WorkNode = LocalWorkNode | ContainerWorkNode

export interface BaseWorkNode {
  id: string
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
  taskName: string
  needs: WorkService[]
  //mergedTask: BuildFileReference
  //mergedDeps: BuildFileReference[]
  console: LogConsole
  labels: LabelValues
  status: StatusConsole
  caching: CacheMethod
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
export const isLocalWorkNode = (val: WorkNode): val is LocalWorkNode => val.type === 'local'
