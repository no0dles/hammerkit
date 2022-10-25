import { Environment } from '../executer/environment'
import { ContainerWorkNode } from '../planner/work-node'
import { Container, ContainerCreateOptions } from 'dockerode'
import { getDocker } from '../executer/execute-docker'
import { removeContainer } from './remove-container'
import { getErrorMessage } from '../log'

export async function usingContainer(
  environment: Environment,
  node: ContainerWorkNode,
  createOptions: ContainerCreateOptions,
  callback: (container: Container) => Promise<void>
) {
  const docker = await getDocker(environment.status.task(node))
  let container: Container | null = null
  try {
    container = await docker.createContainer(createOptions)
    await callback(container)
  } finally {
    if (container) {
      try {
        await removeContainer(container)
      } catch (e) {
        environment.status.task(node).write('error', `remove of container failed ${getErrorMessage(e)}`)
      }
    }
  }
}
