import { WorkNodeCommand } from '../planner/work-node-command'
import { platform } from 'os'
import { CacheMethod } from '../parser/cache-method'
import { PlannedTask } from '../planner/utils/plan-work-node'

export interface WorkNodeCacheDescription {
  cwd: string
  deps: string[]
  src: string[]
  generates: string[]
  envs: { [key: string]: string }
  cmds: WorkNodeCommand[]
  image: string | null
  mounts: string[]
  shell: string | null
  platform: string
  cache: CacheMethod
}

export function getWorkNodeCacheDescription(task: PlannedTask): WorkNodeCacheDescription {
  return {
    shell: task.shell,
    image: task.image,
    platform: task.image ? task.image : platform(),
    generates: task.generates.sort(),
    src: task.src.map((s) => s.relativePath).sort(),
    deps: task.deps.map((d) => d.name).sort(),
    envs: Object.keys(task.envs)
      .sort()
      .reduce<{ [key: string]: string }>((map, key) => {
        map[key] = task.envs[key]
        return map
      }, {}),
    cmds: task.cmds.map((c) => {
      if (typeof c === 'string') {
        return { cmd: c, path: '' }
      } else {
        return { cmd: c.cmd, path: c.path ?? '' }
      }
    }),
    mounts: task.mounts.sort(),
    cwd: task.cwd,
    cache: task.cache,
  }
}
