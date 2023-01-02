import { Environment } from '../executer/environment'
import { ContainerWorkNode } from '../planner/work-node'
import { Container, ContainerCreateOptions } from 'dockerode'
import { removeContainer } from './remove-container'
import { getErrorMessage } from '../log'
import { startContainer } from '../executer/execute-docker'
import { ContainerWorkService } from '../planner/work-service'

export async function usingContainer<T>(
  environment: Environment,
  node: ContainerWorkNode | ContainerWorkService,
  createOptions: ContainerCreateOptions,
  callback: (container: Container) => Promise<T>
) {
  const status = environment.status.from(node)
  let container: Container | null = null
  try {
    container = await environment.docker.createContainer(createOptions)
    status.write('debug', `starting container with image ${node.image}`)
    await startContainer(status, container)
    return await callback(container)
  } finally {
    if (container) {
      try {
        await removeContainer(container)
      } catch (e) {
        status.write('error', `remove of container failed ${getErrorMessage(e)}`)
      }
    }
  }
}
