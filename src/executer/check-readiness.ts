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
  abort: AbortSignal,
  env?: { [key: string]: string },
  // `timeout`: how long one check may take; `name`: the check in the log, else its command
  options: { timeout?: number; name?: string } = {}
): Promise<boolean> {
  const timeout = options.timeout ?? 2000
  const name = options.name ?? command.join(' ')
  const result = await execCommand(status, environment, container, undefined, command, user, timeout, abort, env)

  if (result.type === 'timeout') {
    return false
  } else if (result.type === 'canceled') {
    return false
  } else {
    if (result.result.ExitCode === 0) {
      status.write('debug', `healthcheck ${name} succeeded`)
      return true
    } else {
      status.write('debug', `healthcheck ${name} failed with ${result.result.ExitCode}`)
      return false
    }
  }
}
