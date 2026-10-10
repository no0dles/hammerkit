import Dockerode, { ContainerInfo } from 'dockerode'
import { hostname } from 'os'
import { removeContainer } from './remove-container'

// A hammerkit container nothing will remove any more: a task container (they
// never outlive their run) or a service of a run that is gone, started by a
// hammerkit process of this machine that no longer exists, and the paused
// state records hammerkit kept before 1.9. Services of `up --daemon` and
// containers of other machines or of running processes stay.
export function isOrphanedContainer(container: ContainerInfo, isProcessAlive: (pid: number) => boolean): boolean {
  const labels = container.Labels
  const type = labels['hammerkit-type']
  if (type === 'task' && container.State === 'paused') {
    return true
  }
  if (type !== 'task' && type !== 'service') {
    return false
  }
  if (labels['hammerkit-daemon'] === 'true') {
    return false
  }
  if (labels['hammerkit-host'] !== hostname()) {
    return false
  }
  const pid = parseInt(labels['hammerkit-pid'] ?? '', 10)
  if (!pid) {
    return false
  }
  return !isProcessAlive(pid)
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: any) {
    // EPERM: it exists, it just belongs to another user
    return e.code === 'EPERM'
  }
}

// No daemon listens on the socket or named pipe (ENOENT, or ECONNREFUSED for a
// socket nothing serves). Other failures, such as a permission error, are real.
export function isDockerUnreachable(e: any): boolean {
  return e?.syscall === 'connect' && (e.code === 'ENOENT' || e.code === 'ECONNREFUSED')
}

// Without a Docker daemon there is no container left behind, so a machine that
// has none (a Windows runner without containers, a laptop with Docker stopped)
// cleans without error.
export async function removeOrphanedContainers(docker: Dockerode): Promise<string[]> {
  let containers: ContainerInfo[]
  try {
    containers = await docker.listContainers({ all: true, filters: { label: ['app=hammerkit'] } })
  } catch (e) {
    if (isDockerUnreachable(e)) {
      return []
    }
    throw e
  }
  const orphaned = containers.filter((c) => isOrphanedContainer(c, isProcessAlive))
  for (const container of orphaned) {
    await removeContainer(docker.getContainer(container.Id))
  }
  return orphaned.map((c) => c.Id)
}
