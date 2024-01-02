import Dockerode, { Container, ContainerCreateOptions } from 'dockerode'
import { removeContainer } from './remove-container'
import { getErrorMessage } from '../log'
import { startContainer } from '../executer/execute-docker'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'

export async function usingContainer<T>(
  docker: Dockerode,
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  createOptions: ContainerCreateOptions,
  callback: (container: Container) => Promise<T>
) {
  let container: Container | null = null
  try {
    container = await docker.createContainer(createOptions)
    item.status.write('debug', `starting container with image ${item.data.image}`)
    await startContainer(item.status, container)
    return await callback(container)
  } finally {
    if (container) {
      try {
        await removeContainer(container)
        // TODO do not remove last one, to allow caching
      } catch (e) {
        item.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
      }
    }
  }
}
