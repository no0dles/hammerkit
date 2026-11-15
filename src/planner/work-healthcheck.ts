import { formatDuration } from '../utils/units'
import { WorkCommand } from './work-command'

export interface WorkHttpHealthcheck {
  port: number
  path: string
  scheme: 'http' | 'https'
  // the status codes that count as healthy; null: any 2xx or 3xx
  status: number[] | null
}

// One of a command in the service's container, a request to one of its ports, or a
// connection to one.
export type WorkHealthcheck = ({ cmd: WorkCommand } | { http: WorkHttpHealthcheck } | { tcp: { port: number } }) & {
  // milliseconds the service may take to pass the check once its container runs
  timeout: number
}

// What the check is, in the definition of the service and its cache identity: a command as
// it is written, so those of a service with one stay what they were. Not its timeout.
export function getHealthcheckDefinition(healthcheck: WorkHealthcheck): string | object {
  if ('cmd' in healthcheck) {
    return healthcheck.cmd.cmd
  }
  return 'http' in healthcheck ? { http: healthcheck.http } : { tcp: healthcheck.tcp }
}

// what the check is, for a message
export function describeHealthcheck(healthcheck: WorkHealthcheck): string {
  if ('cmd' in healthcheck) {
    return healthcheck.cmd.cmd
  }
  if ('http' in healthcheck) {
    const { scheme, port, path, status } = healthcheck.http
    return `GET ${scheme}://:${port}${path}${status ? ` (${status.join(', ')})` : ''}`
  }
  return `tcp :${healthcheck.tcp.port}`
}

export function getHealthcheckTimeoutMessage(serviceName: string, healthcheck: WorkHealthcheck): string {
  return (
    `service ${serviceName} did not pass its healthcheck "${describeHealthcheck(healthcheck)}" within ` +
    `${formatDuration(healthcheck.timeout)} of starting (see its log above; raise healthcheck.timeout ` +
    `or HAMMERKIT_HEALTHCHECK_TIMEOUT if it is just slow)`
  )
}
