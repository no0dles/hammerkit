import { array, literal, object, string, union, z } from 'zod'

// A host name, or `*.` and a domain for every name under it. No IP
// addresses: the proxy allows a name, whatever it resolves to.
const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i

// The port the egress proxy serves HTTP on, so no TCP forward can take it.
export const PROXY_PORT = 3128

// Resolvers read a name like `0x7f000001`, `0x7f.1` or `127.1` as an address:
// a hex label, or a numeric last label (no top-level domain is numeric).
function looksLikeAddress(value: string): boolean {
  const labels = value.replace(/^\*\./, '').split('.')
  return /^[0-9]+$/.test(labels[labels.length - 1]) || labels.some((label) => /^0x[0-9a-f]*$/i.test(label))
}

export function isAllowHost(value: string): boolean {
  return HOST_PATTERN.test(value) && !looksLikeAddress(value)
}

// The name a limited item reaches a needed service under: a plain host name,
// which the egress proxy takes as exactly that name.
export function isNeedName(value: string): boolean {
  return !value.startsWith('*.') && isAllowHost(value)
}

// An entry of an allow list: a host for HTTP(S) through the proxy, or a host
// and a port (`db.example.com:5432`) for raw TCP to that port, which the
// proxy forwards for clients that don't speak HTTP proxies (databases,
// caches). A forward names one host, never a wildcard: the item reaches it
// under that name.
export interface AllowEntry {
  host: string
  port: number | null
}

export function parseAllowEntry(value: string): AllowEntry | null {
  const match = /^([^:]+):([0-9]{1,5})$/.exec(value)
  if (!match) {
    return isAllowHost(value) ? { host: value, port: null } : null
  }
  const port = parseInt(match[2], 10)
  return isNeedName(match[1]) && port >= 1 && port <= 65535 && port !== PROXY_PORT ? { host: match[1], port } : null
}

export function isAllowEntry(value: string): boolean {
  return parseAllowEntry(value) !== null
}

// What is wrong with a whole allow list, null when nothing: the proxy listens
// on each forward's port under the item's name for it, so two hosts can't
// share a port.
export function getAllowListError(entries: string[]): string | null {
  const hosts = new Map<number, string>()
  for (const entry of entries.map(parseAllowEntry)) {
    if (!entry || entry.port === null) {
      continue
    }
    const host = hosts.get(entry.port)
    if (host && host.toLowerCase() !== entry.host.toLowerCase()) {
      return `${host}:${entry.port} and ${entry.host}:${entry.port} share a port, each TCP forward needs its own`
    }
    hosts.set(entry.port, entry.host)
  }
  return null
}

export const allowEntrySchema = string().refine(isAllowEntry, (value) => ({
  message:
    `invalid host "${value}", expected a name such as registry.npmjs.org or *.githubusercontent.com, ` +
    `or a name and port such as db.example.com:5432 (any port but ${PROXY_PORT})`,
}))

// What a container task or service reaches besides the services in its
// `needs`, which it reaches at every level: everything the host reaches
// (`open`, the default), nothing (`none`), or the listed hosts through an
// egress proxy: HTTP(S) to a host, raw TCP to a host and port. Not part of
// the cache key.
export const networkSchema = union([
  literal('open'),
  literal('none'),
  object({
    allow: array(allowEntrySchema).superRefine((entries, ctx) => {
      const error = getAllowListError(entries)
      if (error) {
        ctx.addIssue({ code: 'custom', message: error })
      }
    }),
  }).strict(),
]).describe(
  'network the task or service reaches besides its needs: open (default), none or { allow: [hosts or host:port] }'
)

export type NetworkSchema = z.infer<typeof networkSchema>
