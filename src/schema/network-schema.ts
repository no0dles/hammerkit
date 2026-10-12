import { array, literal, object, string, union, z } from 'zod'

// A host name, or `*.` and a domain for every name under it. No ports, no IP
// addresses: the proxy allows a name, whatever it resolves to.
const HOST_PATTERN = /^(\*\.)?([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i
const IP_PATTERN = /^[0-9.]+$/

export function isAllowHost(value: string): boolean {
  return HOST_PATTERN.test(value) && !IP_PATTERN.test(value.replace(/^\*\./, ''))
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
