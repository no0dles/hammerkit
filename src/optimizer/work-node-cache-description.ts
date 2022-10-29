import { WorkNodeCommand } from '../planner/work-node-command'
import { platform } from 'os'
import { PlannedTask } from '../planner/utils/plan-work-node'

export interface WorkNodeCacheDescription {
  cwd?: string
  deps?: string[]
  src?: string[]
  generates?: string[]
  envs?: { [key: string]: string }
  cmds?: WorkNodeCommand[]
  image?: string | null
  mounts?: string[]
  shell?: string | null
  platform?: string
}

export function getWorkNodeCacheDescription(task: PlannedTask): WorkNodeCacheDescription {
  return {
    shell: task.shell ?? undefined,
    image: task.image ?? undefined,
    platform: task.image ? 'container' : platform(),
    generates: task.generates.sort() ?? undefined,
    src: task.src.map((s) => s.relativePath).sort() ?? undefined,
    deps: task.deps.map((d) => d.name).sort() ?? undefined,
    envs:
      Object.keys(task.envs)
        .sort()
        .reduce<{ [key: string]: string }>((map, key) => {
          map[key] = task.envs[key]
          return map
        }, {}) ?? undefined,
    cmds: task.cmds.map((c) => {
      if (typeof c === 'string') {
        return { cmd: c, path: '' }
      } else {
        return { cmd: c.cmd, path: c.path ?? '' }
      }
    }),
    mounts: task.mounts.sort() ?? undefined,
    cwd: task.cwd,
  }
}
