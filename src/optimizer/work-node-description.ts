import { WorkNodeCommand } from '../planner/work-node-command'
import { WorkNodePath } from '../planner/work-node-path'
import { isContainerWorkNode, WorkNode } from '../planner/work-node'

export interface WorkNodeDescription {
  path: string
  deps: string[]
  src: string[]
  generates: string[]
  envs: { [key: string]: string }
  cmds: WorkNodeCommand[]
  image: string | null
  mounts: WorkNodePath[]
}

export function getWorkDescription(node: WorkNode): WorkNodeDescription {
  return {
    path: node.cwd,
    deps: node.deps.map((d) => d.id),
    src: node.src.map((s) => s.absolutePath),
    generates: node.generates,
    cmds: node.cmds,
    image: isContainerWorkNode(node) ? node.image : null,
    mounts: isContainerWorkNode(node) ? node.mounts : [],
    envs: node.envs,
  }
}
