import { Environment } from '../executer/environment'
import { Container, ContainerCreateOptions } from 'dockerode'
import { removeContainer } from './remove-container'
import { getErrorMessage } from '../log'
import { startContainer } from '../executer/execute-docker'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkNode } from '../planner/work-node'

export async function usingContainer<T>(
  environment: Environment,
  item: WorkItem<ContainerWorkNode | ContainerWorkService>,
  createOptions: ContainerCreateOptions,
  callback: (container: Container) => Promise<T>
) {
  let container: Container | null = null
  try {
    container = await environment.docker.createContainer(createOptions)
    item.status.write('debug', `starting container with image ${item.data.image}`)
    await startContainer(item.status, container)
    return await callback(container)
  } finally {
    if (container) {
      try {
        await removeContainer(container)
      } catch (e) {
        item.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
      }
    }
  }
}
