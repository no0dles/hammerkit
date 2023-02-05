import { Container } from 'dockerode'
import { execCommand } from './execute-docker'
import { StatusScopedConsole } from '../planner/work-node-status'
import { Environment } from './environment'
import { WorkHealthcheck } from '../planner/work-healthcheck'

export async function checkReadiness(
  status: StatusScopedConsole,
  healthCheck: WorkHealthcheck,
  environment: Environment,
  container: Container,
  abort: AbortSignal
): Promise<boolean> {
  const result = await execCommand(
    status,
    environment,
    container,
    undefined,
    [healthCheck.cmd.parsed.command, ...healthCheck.cmd.parsed.args],
    null,
    2000,
    abort
  )

  if (result.type === 'timeout') {
    return false
  } else if (result.type === 'canceled') {
    return false
  } else {
    if (result.result.ExitCode === 0) {
      status.write('debug', `healthcheck ${healthCheck.cmd} succeeded`)
      return true
    } else {
      status.write('debug', `healthcheck ${healthCheck.cmd} failed with ${result.result.ExitCode}`)
      return false
    }
  }
}
