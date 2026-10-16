import { getAllowListError, isAllowEntry, isNeedName, NetworkSchema, parseAllowEntry } from '../schema/network-schema'
import { WorkTree } from './work-tree'

// What a task or service reaches besides the services it needs, which it
// reaches at every level. Ordered none < allow < open. The hosts of `allow`
// are names, `*.` patterns, and names with a port for raw TCP. A name reaches
// private addresses, a pattern doesn't; `publicOnly` lists the names that
// don't either, because a ceiling allows them only through a pattern.
export type WorkNetwork =
  | { type: 'open' }
  | { type: 'none' }
  | { type: 'allow'; hosts: string[]; publicOnly?: string[] }

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

// `--network none`, `--network open` or `--network allow:<host>,<host:port>`
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
    const invalid = hosts.find((host) => !isAllowEntry(host))
    if (invalid) {
      throw new Error(
        `invalid host "${invalid}", expected a name such as registry.npmjs.org or *.example.com, ` +
          'or a name and port such as db.example.com:5432'
      )
    }
    const error = getAllowListError(hosts)
    if (error) {
      throw new Error(error)
    }
    return { type: 'allow', hosts: normalizeHosts(hosts) }
  }
  throw new Error(`invalid network "${value}", expected none, open or allow:<host>,<host>`)
}

// The setting under a ceiling: a more open setting is clamped down to it, and
// an allow list under an allow ceiling keeps the hosts both lists allow. A
// name one list allows only through a pattern reaches no private address.
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
  const normalized = normalizeHosts(hosts)
  const publicOnly = normalized.filter(
    (host) => !host.startsWith('*.') && !(coversByName(network, host) && coversByName(ceiling, host))
  )
  return publicOnly.length > 0 ? { type: 'allow', hosts: normalized, publicOnly } : { type: 'allow', hosts: normalized }
}

// Whether a name (not a pattern) of the list covers `host` and may reach
// private addresses.
function coversByName(network: Extract<WorkNetwork, { type: 'allow' }>, host: string): boolean {
  return network.hosts.some(
    (entry) => !entry.startsWith('*.') && !network.publicOnly?.includes(entry) && coversHost(entry, host)
  )
}

// The network of a task or service in this run: its own setting under the
// run's ceiling (`--network`).
export function getEffectiveNetwork(item: { network: WorkNetwork; networkCeiling: WorkNetwork | null }): WorkNetwork {
  return limitNetwork(item.network, item.networkCeiling)
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

// Whether everything `host` (a name, a `*.` pattern or a name and port)
// allows, `limit` allows too. A host without a port reaches every port of it
// through the proxy, so it covers a forward to one of them; a forward covers
// only itself.
function coversHost(limit: string, host: string): boolean {
  const limitEntry = parseAllowEntry(limit)
  const hostEntry = parseAllowEntry(host)
  if (!limitEntry || !hostEntry) {
    return false
  }
  if (limitEntry.port !== null) {
    return hostEntry.port === limitEntry.port && matchesHost(limitEntry.host, hostEntry.host)
  }
  if (hostEntry.host.startsWith('*.')) {
    // `*.b.example.com` is within `*.example.com`
    return (
      limitEntry.host.startsWith('*.') &&
      hostEntry.host.toLowerCase().endsWith(limitEntry.host.toLowerCase().substring(1))
    )
  }
  return matchesHost(limitEntry.host, hostEntry.host)
}

// The raw TCP forwards of a network: the entries of `allow` with a port.
export function getTcpForwards(network: WorkNetwork): { host: string; port: number }[] {
  if (network.type !== 'allow') {
    return []
  }
  return network.hosts
    .map(parseAllowEntry)
    .filter((entry): entry is { host: string; port: number } => entry !== null && entry.port !== null)
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
// error before anything runs. So is a limited item that needs a service under
// a name that is no host name: the proxy passes the names of the needed
// services, and `*.com` would pass every .com host. A TCP forward under the
// name of a needed service would hide that service, so it is an error too, as
// are two forwards on one port, which the ceiling can leave from two lists.
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
  for (const item of [...Object.values(workTree.tasks), ...Object.values(workTree.services)]) {
    if (item.data.type === 'local-task' || item.data.type === 'kubernetes-service') {
      continue
    }
    const network = getEffectiveNetwork(item.data)
    const invalid = item.needs.find((need) => !isNeedName(need.name))
    if (isLimitedNetwork(network) && invalid) {
      throw new Error(
        `${item.name}: network ${formatNetwork(network)} reaches a needed service by a host name, ` +
          `"${invalid.name}" is none (name it like db or api-v2)`
      )
    }
    const shared = network.type === 'allow' ? getAllowListError(network.hosts) : null
    if (shared) {
      const under = limit ? ` under --network ${formatNetwork(limit)}` : ''
      throw new Error(`${item.name}: network ${formatNetwork(network)}${under}, ${shared}`)
    }
    const hidden = getTcpForwards(network).find((forward) =>
      item.needs.some((need) => need.name.toLowerCase() === forward.host.toLowerCase())
    )
    if (hidden) {
      throw new Error(
        `${item.name}: network ${formatNetwork(network)} forwards ${hidden.host}:${hidden.port}, ` +
          `which is the name of a service it needs`
      )
    }
  }
}
