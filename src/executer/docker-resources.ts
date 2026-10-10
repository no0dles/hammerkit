import Dockerode from 'dockerode'
import { WorkResources } from '../planner/work-resources'
import { StatusScopedConsole } from '../planner/work-item-status'

export interface DockerResources {
  NanoCpus?: number
  Memory?: number
}

// The host config limits of a container with these resources; none without.
// Docker refuses more CPUs than the host has, while a limit at or above the
// host's count limits nothing: such a container runs unlimited, with a
// warning, instead of failing or being clamped to fewer CPUs.
export function getDockerResources(
  resources: WorkResources | null,
  hostCpus: number | null,
  status: StatusScopedConsole
): DockerResources {
  if (!resources) {
    return {}
  }
  const limits: DockerResources = {}
  if (resources.cpus !== null) {
    if (hostCpus !== null && resources.cpus > hostCpus) {
      status.write(
        'warn',
        `cpus ${resources.cpus} exceeds the ${hostCpus} cpus of the docker host, running without a cpu limit`
      )
    } else {
      limits.NanoCpus = Math.round(resources.cpus * 1e9)
    }
  }
  if (resources.memory !== null) {
    limits.Memory = resources.memory
  }
  return limits
}

// The limits for the docker host, asking it for its CPU count only when a
// CPU limit is declared.
export async function resolveDockerResources(
  docker: Dockerode,
  resources: WorkResources | null,
  status: StatusScopedConsole
): Promise<DockerResources> {
  const hostCpus = resources?.cpus != null ? await getDockerHostCpus(docker) : null
  return getDockerResources(resources, hostCpus, status)
}

async function getDockerHostCpus(docker: Dockerode): Promise<number | null> {
  const info = await docker.info()
  return typeof info.NCPU === 'number' && info.NCPU > 0 ? info.NCPU : null
}
