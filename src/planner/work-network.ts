import { isAllowHost, NetworkSchema } from '../schema/network-schema'
import { WorkTree } from './work-tree'

// What a task or service reaches besides the services it needs, which it
// reaches at every level. Ordered none < allow < open.
export type WorkNetwork = { type: 'open' } | { type: 'none' } | { type: 'allow'; hosts: string[] }

export const OPEN_NETWORK: WorkNetwork = { type: 'open' }

export function parseWorkNetwork(schema: NetworkSchema | undefined): WorkNetwork {
  if (!schema || schema === 'open') {
    return OPEN_NETWORK
  }
  if (schema === 'none') {
    return { type: 'none' }
  }
  return { type: 'allow', hosts: normalizeHosts(schema.allow) }
}

// `--network none`, `--network open` or `--network allow:<host>,<host>`
export function parseNetworkOption(value: string): WorkNetwork {
  if (value === 'open' || value === 'none') {
    return { type: value }
  }
  if (value.startsWith('allow:')) {
    const hosts = value
      .substring('allow:'.length)
      .split(',')
      .map((host) => host.trim())
      .filter((host) => host.length > 0)
    const invalid = hosts.find((host) => !isAllowHost(host))
    if (invalid) {
      throw new Error(`invalid host "${invalid}", expected a name such as registry.npmjs.org or *.example.com`)
    }
    return { type: 'allow', hosts: normalizeHosts(hosts) }
  }
  throw new Error(`invalid network "${value}", expected none, open or allow:<host>,<host>`)
}

// The setting under a ceiling: a more open setting is clamped down to it, and
// an allow list under an allow ceiling keeps the hosts both lists allow.
export function limitNetwork(network: WorkNetwork, ceiling: WorkNetwork | null): WorkNetwork {
  if (!ceiling || ceiling.type === 'open' || network.type === 'none') {
    return network
  }
  if (ceiling.type === 'none') {
    return ceiling
  }
  if (network.type === 'open') {
    return ceiling
  }
  const hosts = [
    ...network.hosts.filter((host) => ceiling.hosts.some((limit) => coversHost(limit, host))),
    ...ceiling.hosts.filter((limit) => network.hosts.some((host) => coversHost(host, limit))),
  ]
  return { type: 'allow', hosts: normalizeHosts(hosts) }
}

// The network of a task or service in this run: its own setting under the
// run's ceiling (`--network`).
export function getEffectiveNetwork(item: { network: WorkNetwork; networkCeiling: WorkNetwork | null }): WorkNetwork {
  return limitNetwork(item.network, item.networkCeiling)
}

// Whether `network` reaches more than `ceiling` allows: the ceiling would clamp it.
export function exceedsNetwork(network: WorkNetwork, ceiling: WorkNetwork): boolean {
  const limited = limitNetwork(network, ceiling)
  if (limited.type !== network.type) {
    return true
  }
  return network.type === 'allow' && limited.type === 'allow' && limited.hosts.join(',') !== network.hosts.join(',')
}

// The setting as a build file writes it.
export function toNetworkSchema(network: WorkNetwork): NetworkSchema {
  return network.type === 'allow' ? { allow: [...network.hosts] } : network.type
}

export function isLimitedNetwork(network: WorkNetwork): boolean {
  return network.type !== 'open'
}

// Whether a request to `host` passes `pattern`: the same name, or a name under
// the domain of a `*.` pattern (the domain itself is not included).
export function matchesHost(pattern: string, host: string): boolean {
  const name = host.toLowerCase().replace(/\.$/, '')
  const rule = pattern.toLowerCase()
  return rule.startsWith('*.') ? name.endsWith(rule.substring(1)) : name === rule
}

// Whether everything `host` (a name or a `*.` pattern) allows, `limit` allows too.
function coversHost(limit: string, host: string): boolean {
  if (host.startsWith('*.')) {
    // `*.b.example.com` is within `*.example.com`
    return limit.startsWith('*.') && host.toLowerCase().endsWith(limit.toLowerCase().substring(1))
  }
  return matchesHost(limit, host)
}

function normalizeHosts(hosts: string[]): string[] {
  return [...new Set(hosts.map((host) => host.toLowerCase()))].sort()
}

export function formatNetwork(network: WorkNetwork): string {
  if (network.type === 'allow') {
    return network.hosts.length > 0 ? `allow ${network.hosts.join(', ')}` : 'allow (no hosts)'
  }
  return network.type
}

// Sets the run's ceiling on every task and service of the work tree. A local
// task can't be limited, so a ceiling below open with one in the run is an
// error before anything runs.
export function applyNetworkCeiling(workTree: WorkTree, ceiling: WorkNetwork | null): void {
  const limit = ceiling && isLimitedNetwork(ceiling) ? ceiling : null
  if (limit) {
    const local = Object.values(workTree.tasks).find((task) => task.data.type === 'local-task')
    if (local) {
      throw new Error(
        `--network ${formatNetwork(limit)} needs every task in a container, ` +
          `hammerkit can't limit the network of the local task ${local.name}`
      )
    }
  }
  for (const task of Object.values(workTree.tasks)) {
    task.data.networkCeiling = limit
  }
  for (const service of Object.values(workTree.services)) {
    if (service.data.type === 'container-service') {
      service.data.networkCeiling = limit
    }
  }
}
