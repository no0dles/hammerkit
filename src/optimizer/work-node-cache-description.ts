import { platform } from 'os'
import { WorkNode } from '../planner/work-node'

export interface WorkNodeCacheDescription {
  cwd?: string
  deps?: string[]
  src?: string[]
  generates?: string[]
  envs?: { [key: string]: string }
  cmds?: { cwd: string; cmd: string }[]
  image?: string | null
  mounts?: string[]
  shell?: string | null
  platform?: string
}

export function getWorkNodeCacheDescription(task: WorkNode): WorkNodeCacheDescription {
  return {
    shell: task.shell ?? undefined,
    platform: task.type === 'container-task' ? task.image : platform(),
    generates: task.generates.map((g) => g.path).sort() ?? undefined,
    src: task.src.map((s) => s.source).sort() ?? undefined,
    // TODO verify if thats correct deps: task.deps.map((d) => d.name).sort() ?? undefined,
    envs:
      Object.keys(task.envs)
        .sort()
        .reduce<{ [key: string]: string }>((map, key) => {
          map[key] = task.envs[key]
          return map
        }, {}) ?? undefined,
    cmds: task.cmds.map((c) => ({ cmd: c.cmd, cwd: c.cwd })),
    mounts: task.type === 'container-task' ? task.mounts.map((m) => m.mount).sort() : undefined,
    cwd: task.cwd,
  }
}
