import { ContainerWorkNode } from '../planner/work-node'
import Dockerode, { Container } from 'dockerode'
import { execCommand } from './execute-docker'

export async function setUserPermission(
  directory: string,
  node: ContainerWorkNode,
  docker: Dockerode,
  container: Container,
  user: string,
  abort: AbortSignal
): Promise<void> {
  node.status.write('debug', `set permission on ${directory}`)
  const result = await execCommand(
    node,
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
    node.status.write('warn', `unable to set permissions for ${directory}`)
  }
}
