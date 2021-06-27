import { BuildFile } from '../parser/build-file'
import { WorkNodeSource } from './work-node-source'
import { WorkNodeCommand } from './work-node-command'
import { WorkNodeMount } from './work-node-mount'
import { WorkNodeStatus } from './work-node-status'

export interface WorkNode {
  id: string
  name: string
  path: string
  description: string | null
  deps: WorkNode[]
  status: WorkNodeStatus
  src: WorkNodeSource[]
  generates: string[]
  envs: { [key: string]: string }
  cmds: WorkNodeCommand[]
  unknownProps: { [key: string]: any }
  buildFile: BuildFile
  taskName: string
}

export interface ContainerWorkNode extends WorkNode {
  image: string
  shell: string
  mounts: WorkNodeMount[]
}

export const isContainerWorkNode = (val: WorkNode): val is ContainerWorkNode => !!(<ContainerWorkNode>val).image
