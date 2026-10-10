import { platform } from 'os'
import { createHash } from 'crypto'
import { WorkTask } from '../planner/work-task'
import { getEnvironmentVariables } from '../environment/replace-env-variables'
import { portablePath } from '../planner/utils/portable-path'
import { WorkItem } from '../planner/work-item'
import { getPortableSecretName } from '../planner/work-secret'

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
  arch?: string
  // `cache: true` secrets: name and salted digest, never the value
  secrets?: string[]
}

// Every path is made project-relative (portablePath) so the description, and the
// task id hashed from it, is identical wherever the project is checked out.
//
// `deps` holds the dependencies' task ids, so a change to a dependency's
// definition (command, env, image, …) gives every task depending on it a new id.
// The state key only folds in the dependencies' *sources*.
export function getWorkTaskCacheDescription(item: WorkItem<WorkTask>): WorkTaskCacheDescription {
  const task = item.data
  const portable = (path: string) => portablePath(task.projectRoot, path)
  const envs = getEnvironmentVariables(task.envs)
  const cachedSecrets = task.secrets
    .filter((secret) => secret.cache)
    .map((secret) => `${getPortableSecretName(task.projectRoot, secret)}=${secret.digest()}`)
    .sort()
  return {
    shell: task.shell ?? undefined,
    platform: task.type === 'container-task' ? task.image : platform(),
    // outputs hold native binaries, and docker pulls images for the host
    // architecture, so container tasks are keyed by it too
    arch: process.arch,
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
    deps: item.deps.length > 0 ? item.deps.map((dep) => dep.id()).sort() : undefined,
    secrets: cachedSecrets.length > 0 ? cachedSecrets : undefined,
  }
}

// The form written to disk: description.json in a cache entry (pushed to remote
// backends, readable by everyone who can pull) and the local explain record.
// Env is where tokens get passed, so each value is stored as a digest; the task
// id is still hashed from the values themselves.
export function storedCacheDescription(description: WorkTaskCacheDescription): WorkTaskCacheDescription {
  if (!description.envs) {
    return description
  }
  const envs: { [key: string]: string } = {}
  for (const [key, value] of Object.entries(description.envs)) {
    envs[key] = `sha256:${createHash('sha256').update(value).digest('hex')}`
  }
  return { ...description, envs }
}
