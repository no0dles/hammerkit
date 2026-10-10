import Dockerode from 'dockerode'
import { WorkResources } from '../planner/work-resources'
import { StatusScopedConsole } from '../planner/work-item-status'

export interface DockerResources {
  NanoCpus?: number
  Memory?: number
  MemoryReservation?: number
}

// The host config limits of a container with these resources; none without.
// A memory request below the limit is a soft reservation; Docker has no CPU
// request, the run schedules by it (see ResourceBudget). Docker refuses more CPUs than the host has, while a limit at or above the
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
  const { limits, requests } = resources
  const config: DockerResources = {}
  if (limits.cpus !== null) {
    if (hostCpus !== null && limits.cpus > hostCpus) {
      status.write(
        'warn',
        `cpus ${limits.cpus} exceeds the ${hostCpus} cpus of the docker host, running without a cpu limit`
      )
    } else {
      config.NanoCpus = Math.round(limits.cpus * 1e9)
    }
  }
  if (limits.memory !== null) {
    config.Memory = limits.memory
  }
  if (requests.memory !== null && (limits.memory === null || requests.memory < limits.memory)) {
    config.MemoryReservation = requests.memory
  }
  return config
}

// The limits for the docker host, asking it for its CPU count only when a
// CPU limit is declared.
export async function resolveDockerResources(
  docker: Dockerode,
  resources: WorkResources | null,
  status: StatusScopedConsole
): Promise<DockerResources> {
  const hostCpus = resources?.limits.cpus != null ? await getDockerHostCpus(docker) : null
  return getDockerResources(resources, hostCpus, status)
}

async function getDockerHostCpus(docker: Dockerode): Promise<number | null> {
  const info = await docker.info()
  return typeof info.NCPU === 'number' && info.NCPU > 0 ? info.NCPU : null
}
