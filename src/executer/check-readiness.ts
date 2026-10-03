import { Container } from 'dockerode'
import { execCommand } from './execute-docker'
import { StatusScopedConsole } from '../planner/work-item-status'
import { Environment } from './environment'

export async function checkReadiness(
  status: StatusScopedConsole,
  command: string[],
  environment: Environment,
  container: Container,
  user: string | null,
  abort: AbortSignal
): Promise<boolean> {
  const result = await execCommand(status, environment, container, undefined, command, user, 2000, abort)

  if (result.type === 'timeout') {
    return false
  } else if (result.type === 'canceled') {
    return false
  } else {
    if (result.result.ExitCode === 0) {
      status.write('debug', `healthcheck ${command.join(' ')} succeeded`)
      return true
    } else {
      status.write('debug', `healthcheck ${command.join(' ')} failed with ${result.result.ExitCode}`)
      return false
    }
  }
}
