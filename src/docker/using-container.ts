import Dockerode, { Container, ContainerCreateOptions } from 'dockerode'
import { removeContainer } from './remove-container'
import { getErrorMessage } from '../log'
import { startContainer } from '../executer/execute-docker'
import { WorkItem } from '../planner/work-item'
import { ContainerWorkService } from '../planner/work-service'
import { ContainerWorkTask } from '../planner/work-task'
import { getWorkInstanceId } from '../planner/work-instance-id'
import { isProcessAlive } from './remove-orphaned-containers'

// Runs the callback in a fresh container and removes it afterwards, whatever
// the outcome. What state the outputs hold is recorded outside docker (see
// container-task-state.ts), so no container outlives the run.
export async function usingContainer<T>(
  docker: Dockerode,
  item: WorkItem<ContainerWorkTask | ContainerWorkService>,
  createOptions: ContainerCreateOptions,
  callback: (container: Container) => Promise<T>
): Promise<T> {
  await removeLeftoverContainers(docker, item)
  let container: Container | null = null
  try {
    container = await docker.createContainer(createOptions)
    item.status.write('debug', `starting container with image ${item.data.image}`)
    await startContainer(item.status, container)
    return await callback(container)
  } finally {
    try {
      if (container) {
        await removeContainer(container)
      }
    } catch (e) {
      item.status.write('error', `remove of container failed ${getErrorMessage(e)}`)
    }
  }
}

// Containers of this item nothing will remove: the paused state records
// hammerkit kept before 1.9, and stopped ones of a hammerkit process that is
// gone. A container of a live process (one another call of this run has just
// created, say) stays.
async function removeLeftoverContainers(
  docker: Dockerode,
  item: WorkItem<ContainerWorkTask | ContainerWorkService>
): Promise<void> {
  const containers = await docker.listContainers({
    all: true,
    filters: { label: [`hammerkit-id=${getWorkInstanceId(item)}`] },
  })
  const leftovers = containers.filter(
    (c) =>
      c.State === 'paused' ||
      (c.State !== 'running' && !isProcessAlive(parseInt(c.Labels['hammerkit-pid'] ?? '', 10) || process.pid))
  )
  for (const leftover of leftovers) {
    item.status.write('debug', `remove leftover container ${leftover.Id}`)
    await removeContainer(docker.getContainer(leftover.Id))
  }
}
