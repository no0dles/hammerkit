import { Environment } from './environment'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { join } from 'path'
import { moveFiles } from '../file/move-files'
import { getDocker, getVolumeName } from './execute-docker'
import { removeContainer } from '../docker/remove-container'
import { existsVolume } from './get-docker-executor'
import { WorkTree } from '../planner/work-tree'

export async function restoreCache(path: string, workTree: WorkTree, environment: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(path, 'cache', node.id)

    await moveFiles(node, environment, function* () {
      yield { from: sourceCacheDir, to: cachePath }
    })
  }
}

export async function storeCache(path: string, workTree: WorkTree, environment: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(path, 'cache', node.id)

    await moveFiles(node, environment, function* () {
      yield { from: cachePath, to: sourceCacheDir }
    })
  }
}

export async function cleanCache(workTree: WorkTree, environment: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    const status = environment.status.task(node)
    const docker = await getDocker(status)

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

  for (const service of iterateWorkServices(workTree.services)) {
    const status = environment.status.service(service)
    const docker = await getDocker(status)

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

  for (const node of iterateWorkNodes(workTree.nodes)) {
    const nodeStatus = environment.status.task(node)
    const docker = await getDocker(nodeStatus)

    for (const generate of node.generates) {
      if (generate.inherited) {
        continue
      }

      const volumeName = getVolumeName(generate.path)
      const volumeExists = await existsVolume(docker, volumeName)
      if (volumeExists) {
        nodeStatus.write('info', `remove volume ${volumeName}`)
        const volume = await docker.getVolume(volumeName)
        await volume.remove()
      } else {
        nodeStatus.write('info', `generate ${generate} has no volume ${volumeName}`)
      }

      nodeStatus.write('info', `remove local directory ${generate.path}`)
      await environment.file.remove(generate.path)
    }

    const cachePath = getCacheDirectory(node.id)
    if (await environment.file.exists(cachePath)) {
      nodeStatus.write('info', `remove cache ${cachePath}`)
      await environment.file.remove(cachePath)
    }
  }
}
