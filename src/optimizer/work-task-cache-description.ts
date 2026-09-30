import { platform } from 'os'
import { WorkTask } from '../planner/work-task'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { portablePath } from '../planner/utils/portable-path'

export interface WorkTaskCacheDescription {
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

// Every path is made project-relative (portablePath) so the description, and the
// task id hashed from it, is identical wherever the project is checked out.
export function getWorkTaskCacheDescription(task: WorkTask): WorkTaskCacheDescription {
  const portable = (path: string) => portablePath(task.projectRoot, path)
  const envs = getEnvironmentVariables(task.envs)
  return {
    shell: task.shell ?? undefined,
    platform: task.type === 'container-task' ? task.image : platform(),
    generates: task.generates.map((g) => portable(g.path)).sort() ?? undefined,
    src: task.src.map((s) => s.source).sort() ?? undefined,
    envs:
      Object.keys(envs)
        .sort()
        .reduce<{ [key: string]: string }>((map, key) => {
          map[key] = envs[key]
          return map
        }, {}) ?? undefined,
    cmds: task.cmds.map((c) => ({ cmd: c.cmd, cwd: portable(c.cwd) })),
    mounts: task.type === 'container-task' ? task.mounts.map((m) => m.mount).sort() : undefined,
    cwd: portable(task.cwd),
  }
}
