import { array, enum as zenum, number, object, string, union, z } from 'zod'
import { durationSchema } from './duration-schema'

// How long the service may take to pass its check once its container runs
// (default 20s, HAMMERKIT_HEALTHCHECK_TIMEOUT changes the default).
const timeout = durationSchema.optional()

const port = number().int().min(1).max(65535)

// A request to a port of the service, from its own network: no tool of the image runs it.
export const buildFileServiceHttpHealthcheck = object({
  port,
  path: string().startsWith('/', 'path must start with /').optional(),
  scheme: zenum(['http', 'https']).optional(),
  // the status codes that count as healthy, any 2xx or 3xx without
  status: array(number().int().min(100).max(599)).min(1).optional(),
})
  .strict()
  .describe('GET <scheme>://<service>:<port><path>, healthy on one of status (default any 2xx or 3xx)')

// a connection to a port of the service
export const buildFileServiceTcpHealthcheck = object({ port })
  .strict()
  .describe('healthy once <port> takes a connection')

// Exactly one of `cmd`, `http` or `tcp`.
export const buildFileServiceContainerHealthcheck = union([
  object({ cmd: string(), timeout }).strict(),
  object({ http: buildFileServiceHttpHealthcheck, timeout }).strict(),
  object({ tcp: buildFileServiceTcpHealthcheck, timeout }).strict(),
]).describe('exactly one of cmd, http or tcp, and how long it may take to pass')

export type BuildFileServiceContainerHealthcheck = z.infer<typeof buildFileServiceContainerHealthcheck>
