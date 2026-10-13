import { array, literal, object, string, union, z } from 'zod'

// A host name, or `*.` and a domain for every name under it. No ports, no IP
// addresses: the proxy allows a name, whatever it resolves to.
const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i

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

export const allowHostSchema = string().refine(isAllowHost, (value) => ({
  message: `invalid host "${value}", expected a name such as registry.npmjs.org or *.githubusercontent.com`,
}))

// What a container task or service reaches besides the services in its
// `needs`, which it reaches at every level: everything the host reaches
// (`open`, the default), nothing (`none`), or HTTP(S) to the listed hosts
// through an egress proxy. Not part of the cache key.
export const networkSchema = union([
  literal('open'),
  literal('none'),
  object({
    allow: array(allowHostSchema),
  }).strict(),
]).describe('network the task or service reaches besides its needs: open (default), none or { allow: [hosts] }')

export type NetworkSchema = z.infer<typeof networkSchema>
