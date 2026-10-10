import { formatDuration } from '../utils/units'
import { WorkCommand } from './work-command'

export interface WorkHealthcheck {
  cmd: WorkCommand
  // milliseconds the service may take to pass `cmd` once its container runs
  timeout: number
}

export function getHealthcheckTimeoutMessage(serviceName: string, healthcheck: WorkHealthcheck): string {
  return (
    `service ${serviceName} did not pass its healthcheck "${healthcheck.cmd.cmd}" within ` +
    `${formatDuration(healthcheck.timeout)} of starting (see its log above; raise healthcheck.timeout ` +
    `or HAMMERKIT_HEALTHCHECK_TIMEOUT if it is just slow)`
  )
}
