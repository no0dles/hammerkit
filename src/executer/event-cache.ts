import { Environment } from './environment'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { join } from 'path'
import { moveFiles } from '../file/move-files'
import { getDocker, getVolumeName } from './execute-docker'
import { removeContainer } from '../docker/remove-container'
import { WorkNodes } from '../planner/work-nodes'
import { WorkServices } from '../planner/work-services'
import { existsVolume } from './get-docker-executor'

export async function restoreCache(
  path: string,
  nodes: WorkNodes,
  services: WorkServices,
  environment: Environment
): Promise<void> {
  for (const node of iterateWorkNodes(nodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(path, 'cache', node.id)

    await moveFiles(node, environment, function* () {
      yield { from: sourceCacheDir, to: cachePath }
    })
  }
}

export async function storeCache(
  path: string,
  nodes: WorkNodes,
  services: WorkServices,
  environment: Environment
): Promise<void> {
  for (const node of iterateWorkNodes(nodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(path, 'cache', node.id)

    await moveFiles(node, environment, function* () {
      yield { from: cachePath, to: sourceCacheDir }
    })
  }
}

export async function cleanCache(nodes: WorkNodes, services: WorkServices, environment: Environment): Promise<void> {
  for (const node of iterateWorkNodes(nodes)) {
    const docker = await getDocker(node)

    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`hammerkit-id=${node.id}`],
      },
    })
    for (const container of containers) {
      await removeContainer(docker.getContainer(container.Id))
    }
  }

  for (const service of iterateWorkServices(services)) {
    const docker = await getDocker(service)

    const containers = await docker.listContainers({
      all: true,
      filters: {
        label: [`hammerkit-id=${service.id}`],
      },
    })
    for (const container of containers) {
      await removeContainer(docker.getContainer(container.Id))
    }
  }

  for (const node of iterateWorkNodes(nodes)) {
    const docker = await getDocker(node)

    for (const generate of node.generates) {
      if (generate.inherited) {
        continue
      }

      const volumeName = getVolumeName(generate.path)
      const volumeExists = await existsVolume(docker, volumeName)
      if (volumeExists) {
        node.status.write('info', `remove volume ${volumeName}`)
        const volume = await docker.getVolume(volumeName)
        await volume.remove()
      } else {
        node.status.write('info', `generate ${generate} has no volume ${volumeName}`)
      }

      node.status.write('info', `remove local directory ${generate.path}`)
      await environment.file.remove(generate.path)
    }

    const cachePath = getCacheDirectory(node.id)
    if (await environment.file.exists(cachePath)) {
      node.status.write('info', `remove cache ${cachePath}`)
      await environment.file.remove(cachePath)
    }
  }
}
