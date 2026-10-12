import { V1Toleration } from '@kubernetes/client-node'
import { WorkKubernetesEnvironment, WorkKubernetesPool, WorkKubernetesServer } from '../planner/work-environment'
import { ContainerWorkTask, LocalWorkTask } from '../planner/work-task'

// What a local task says it runs on (`platform` of build-file-local-platform-schema)
interface LocalPlatform {
  os?: 'win' | 'macos' | 'linux'
  arch?: 'arm64' | 'arm'
}

/**
 * The pool a local task runs on: the first that offers its platform. A pool says
 * `linux` with `amd64` or `arm64`, so a task that names another platform has none.
 */
export function getLocalTaskPool(
  server: WorkKubernetesServer,
  name: string,
  platform: LocalPlatform | undefined
): WorkKubernetesPool {
  if (platform?.os === 'macos' || platform?.os === 'win') {
    throw new Error(
      `task ${name}: runs on ${platform.os === 'win' ? 'Windows' : 'macOS'}, this server runs tasks on Linux nodes`
    )
  }
  if (platform?.arch === 'arm') {
    throw new Error(`task ${name}: runs on arm, the pools of this server offer amd64 and arm64`)
  }
  const pools = server.pools.filter((pool) => !platform?.arch || pool.platform.arch === platform.arch)
  const pool = pools.find((candidate) => candidate.toolImage)
  if (!pool) {
    throw new Error(
      `task ${name}: a local task runs in the toolImage of a pool, and no pool${
        platform?.arch ? ` for ${platform.arch}` : ''
      } of this server has one`
    )
  }
  return pool
}

/**
 * A local task on a cluster: a container of the pool's tool image, which runs its
 * commands in the same directories as a container task would.
 */
export function runInToolImage(
  task: LocalWorkTask,
  server: WorkKubernetesServer,
  platform: LocalPlatform | undefined
): ContainerWorkTask {
  const pool = getLocalTaskPool(server, task.name, platform)
  return {
    ...task,
    type: 'container-task',
    image: pool.toolImage as string,
    user: null,
    mounts: [],
    pool: pool.name,
  }
}

export interface PodPlacement {
  nodeSelector: { [label: string]: string }
  tolerations: V1Toleration[]
}

// Where the pod of a task goes: its pool's nodes, the first pool unless a local task
// chose another.
export function getPodPlacement(server: WorkKubernetesServer, pool: string | undefined): PodPlacement {
  const chosen = server.pools.find((candidate) => candidate.name === pool) ?? server.pools[0]
  return {
    nodeSelector: {
      'kubernetes.io/os': chosen.platform.os,
      'kubernetes.io/arch': chosen.platform.arch,
      ...chosen.nodeSelector,
    },
    tolerations: chosen.tolerations,
  }
}

// On a server everything made for a run carries its id, so the server removes all of
// it when the run ends, and a NetworkPolicy can select the pods of a run.
export const RUN_LABEL = 'hammerkit.dev/run'

export function getRunLabels(kubernetes: Pick<WorkKubernetesEnvironment, 'server'>): { [label: string]: string } {
  return kubernetes.server ? { [RUN_LABEL]: kubernetes.server.run } : {}
}
