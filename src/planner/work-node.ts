import { BuildFile } from '../parser/build-file'
import { WorkNodeSource } from './work-node-source'
import { WorkNodeCommand } from './work-node-command'
import { WorkNodePath } from './work-node-path'
import { WorkNodeStatus } from './work-node-status'
import { MergedBuildFileTask, MergedDependency } from './utils/plan-work-node'
import { WorkNodePort } from './work-node-port'

export type WorkNode = LocalWorkNode | ContainerWorkNode

export interface BaseWorkNode {
  id: string
  name: string
  cwd: string
  description: string | null
  continuous: boolean
  deps: WorkNode[]
  src: WorkNodeSource[]
  status: WorkNodeStatus
  generates: { path: string; inherited: boolean }[]
  envs: { [key: string]: string }
  cmds: WorkNodeCommand[]
  unknownProps: { [key: string]: any }
  buildFile: BuildFile
  taskName: string
  mergedTask: MergedBuildFileTask
  mergedDeps: MergedDependency[]
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
