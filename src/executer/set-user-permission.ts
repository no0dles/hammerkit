import { Container } from 'dockerode'
import { execCommand } from './execute-docker'
import { StatusScopedConsole } from '../planner/work-item-status'
import { Environment } from './environment'

export async function setUserPermission(
  directory: string,
  status: StatusScopedConsole,
  environment: Environment,
  container: Container,
  user: string
): Promise<void> {
  status.write('debug', `set permission on ${directory}`)
  const result = await execCommand(
    status,
    environment,
    container,
    '/',
    ['chown', user, directory],
    null,
    undefined,
    new AbortController().signal
  )
  if (result.type === 'canceled') {
    return
  }
  if (result.type === 'timeout' || result.result.ExitCode !== 0) {
    status.write('warn', `unable to set permissions for ${directory}`)
  }
}
