import { WorkNodeCommand } from '../planner/work-node-command'
import { platform } from 'os'
import { MergedBuildFileTask, MergedDependency } from '../planner/utils/plan-work-node'

export interface WorkNodeDescription {
  deps: string[]
  src: string[]
  generates: string[]
  envs: { [key: string]: string }
  cmds: WorkNodeCommand[]
  image: string | null
  mounts: string[]
  shell: string | null
  platform: string | null
}

export function getWorkDescription(task: MergedBuildFileTask, deps: MergedDependency[]): WorkNodeDescription {
  return {
    shell: task.shell,
    image: task.image,
    platform: task.image ? null : platform(),
    generates: (task.generates ?? []).sort(),
    src: (task.src ? task.src.map((s) => s.relativePath) : []).sort(),
    deps: (deps ?? []).map((d) => d.name).sort(),
    envs: task.envs ?? {},
    cmds: (task.cmds ?? []).map((c) => {
      if (typeof c === 'string') {
        return { cmd: c, path: '' }
      } else {
        return { cmd: c.cmd, path: c.path ?? '' }
      }
    }),
    mounts: task.mounts.sort(),
  }
}
