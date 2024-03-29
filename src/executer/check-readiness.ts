import { ExecutionBuildServiceHealthCheck } from '../parser/build-file-service'
import { Container } from 'dockerode'
import { execCommand } from './execute-docker'
import { StatusScopedConsole } from '../planner/work-node-status'
import { Environment } from './environment'

export async function checkReadiness(
  status: StatusScopedConsole,
  healthCheck: ExecutionBuildServiceHealthCheck,
  environment: Environment,
  container: Container,
  abort: AbortSignal
): Promise<boolean> {
  const result = await execCommand(
    status,
    environment,
    container,
    undefined,
    healthCheck.cmd.split(' '),
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
