import Dockerode, { Container } from 'dockerode'
import { execCommand } from './execute-docker'
import { StatusScopedConsole } from '../planner/work-node-status'

export async function setUserPermission(
  directory: string,
  status: StatusScopedConsole,
  docker: Dockerode,
  container: Container,
  user: string,
  abort: AbortSignal
): Promise<void> {
  status.write('debug', `set permission on ${directory}`)
  const result = await execCommand(
    status,
    docker,
    container,
    '/',
    ['chown', user, directory],
    undefined,
    undefined,
    abort
  )
  if (result.type === 'canceled') {
    return
  }
  if (result.type === 'timeout' || result.result.ExitCode !== 0) {
    status.write('warn', `unable to set permissions for ${directory}`)
  }
}
