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
  stateKey: string | null,
  callback: (container: Container) => Promise<T>
) {
  let container: Container | null = null
  try {
    container = await docker.createContainer(createOptions)
    item.status.write('debug', `starting container with image ${item.data.image}`)
    await startContainer(item.status, container)
    return await callback(container)
  } finally {
    try {
      if (stateKey) {
        if (container) {
          await container.pause()
        }
        const containers = await docker.listContainers({ all: true, filters: { label: [`hammerkit-id=${item.id()}`] } })
        for (const container of containers) {
          item.status.write('debug', `found container ${container.Id}`)
          if (container.Labels['hammerkit-state'] != stateKey) {
            const oldContainer = docker.getContainer(container.Id)
            await removeContainer(oldContainer)
          }
        }
      } else {
        if (container) {
          await removeContainer(container)
        }
      }
    } catch (e) {
      item.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
    }
  }
}
