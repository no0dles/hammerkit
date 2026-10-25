import { createHash } from 'crypto'
import { getCredentialReads, TaskPlan } from './plan'
import { endpointLevel, Grant } from './policy'
import type { Run, RunEndpoint } from './runs'
import type { RunRequest } from './run-request'
import { SERVICE_RUN_NAME_PATTERN } from './run-request'

// The name of a service run when the request names none: the branch it runs from, as a DNS
// label, so the runs of several branches stand side by side and each keeps its hosts.
export function getServiceRunName(branch: string | undefined): string {
  const name = (branch ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '')
  return SERVICE_RUN_NAME_PATTERN.test(name) ? name : 'run'
}

/**
 * The host labels of a run's endpoints: its name, the port and six hex digits of its
 * owner, so two callers with a branch of the same name get hosts of their own, and a run
 * that replaces another of the same name takes over its hosts. Two endpoints on the same
 * port (of two services) are told apart by their place.
 */
export function getEndpointHosts(
  name: string,
  owner: { iss: string; sub: string },
  endpoints: { service: string; port: number }[]
): string[] {
  const of = createHash('sha256').update(`${owner.iss}\0${owner.sub}`).digest('hex').slice(0, 6)
  return endpoints.map((endpoint, index) =>
    endpoints.findIndex((other) => other.port === endpoint.port) === index
      ? `${name}-${endpoint.port}-${of}`
      : `${name}-${endpoint.port}-${index}-${of}`
  )
}

// The container port of each `host:container` port of a planned service.
function containerPorts(plan: TaskPlan): number[] {
  return plan.ports.map((port) => Number(port.split(':').pop()))
}

/**
 * Why the endpoints of a service run can't be published, or null. Each is a port its
 * service declares, of a service the run starts. Under a `runs.secretNetwork` below `open`
 * a service behind an endpoint may not read a secret or a credential of the server: a page
 * is a way out that no mask of the log covers.
 */
export function refuseEndpoints(
  request: Pick<RunRequest, 'endpoints'>,
  plan: Record<string, TaskPlan>,
  secretNetworkOpen: boolean
): string | null {
  for (const endpoint of request.endpoints) {
    const item = plan[endpoint.service]
    if (!item || item.kind !== 'service') {
      return `the endpoint ${endpoint.service}:${endpoint.port} names no service the run starts`
    }
    if (!containerPorts(item).includes(endpoint.port)) {
      const ports = containerPorts(item)
      return `${endpoint.service} has no port ${endpoint.port}${
        ports.length > 0 ? `, its ports are ${ports.join(', ')}` : ', it declares none'
      }`
    }
    const reads = getCredentialReads(item)
    if (!secretNetworkOpen && reads.length > 0) {
      return `${endpoint.service} reads ${reads.join(
        ', '
      )}, it can not be behind an endpoint on this server (runs.secretNetwork): a page could show it`
    }
  }
  return null
}

export function toRunEndpoints(
  endpoints: { service: string; port: number }[],
  hosts: string[],
  url: (host: string) => string
): RunEndpoint[] {
  return endpoints.map((endpoint, index) => ({
    service: endpoint.service,
    port: endpoint.port,
    host: hosts[index],
    url: url(hosts[index]),
  }))
}

// The repository of a run's source, which the endpoints grants are written for.
export function getRunRepo(run: Pick<Run, 'source'>): string | null {
  return run.source.type === 'upload' ? null : run.source.repo
}

// Who may open the endpoints of a service run, and extend it, besides its owner: those
// with an `open` or `publish` level for its repository.
export function mayOpenEndpoints(grant: Grant, run: Pick<Run, 'source'>): boolean {
  const repo = getRunRepo(run)
  return repo !== null && endpointLevel(grant, repo) !== null
}
