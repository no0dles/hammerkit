import { Environment } from './environment'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { dirname, join, relative, sep } from 'path'
import { moveFiles } from '../file/move-files'
import { convertToPosixPath, getContainerVolumes, getDocker, getVolumeName } from './execute-docker'
import { removeContainer } from '../docker/remove-container'
import { existsVolume } from './get-docker-executor'
import { WorkTree } from '../planner/work-tree'
import { create, extract } from 'tar'
import { createReadStream, createWriteStream } from 'fs'
import { ContainerWorkNode, isContainerWorkNode, LocalWorkNode, WorkNode } from '../planner/work-node'
import { pipeline } from 'stream/promises'
import { usingContainer } from '../docker/using-container'

export async function restoreCache(path: string, workTree: WorkTree, environment: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(path, 'cache', node.id)

    await moveFiles(node, environment, function* () {
      yield { from: sourceCacheDir, to: cachePath }
    })

    if (isContainerWorkNode(node)) {
      await restoreContainer(environment, node, sourceCacheDir)
    } else {
      await restoreLocal(environment, node, sourceCacheDir)
    }
  }
}

async function restoreLocal(environment: Environment, node: LocalWorkNode, sourceCacheDir: string) {
  const archiveFile = join(sourceCacheDir, 'generates.tgz')
  if (await environment.file.exists(archiveFile)) {
    await extract({
      file: archiveFile,
      cwd: node.cwd,
    })
  }
}

async function restoreContainer(environment: Environment, node: ContainerWorkNode, path: string) {
  const volumes = await getContainerVolumes(node)
  await usingContainer(
    environment,
    node,
    {
      Image: node.image,
      Tty: true,
      Entrypoint: 'sh',
      Cmd: ['-c', 'sleep 3600'],
      WorkingDir: convertToPosixPath(node.cwd),
      Labels: { app: 'hammerkit', 'hammerkit-id': node.id, 'hammerkit-type': 'task' },
      HostConfig: {
        AutoRemove: true,
        Binds: [...volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`)],
      },
    },
    async (container) => {
      await container.start()

      const generates = node.generates.filter((g) => !g.inherited)
      for (const generate of generates) {
        const generateId = getGenerateId(node, generate.path)
        const archiveFile = createReadStream(join(path, generateId + '-generates.tgz'))
        await container.putArchive(archiveFile, {
          path: dirname(generate.path),
        })
      }
    }
  )
}

function getGenerateId(node: WorkNode, path: string): string {
  return relative(node.cwd, path).split(sep).join('-')
}

async function archiveContainer(environment: Environment, node: ContainerWorkNode, path: string) {
  const volumes = await getContainerVolumes(node)
  await usingContainer(
    environment,
    node,
    {
      Image: node.image,
      Tty: true,
      Entrypoint: 'sh',
      Cmd: ['-c', 'sleep 3600'],
      WorkingDir: convertToPosixPath(node.cwd),
      Labels: { app: 'hammerkit', 'hammerkit-id': node.id, 'hammerkit-type': 'task' },
      HostConfig: {
        AutoRemove: true,
        Binds: [...volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`)],
      },
    },
    async (container) => {
      await container.start()

      const generates = node.generates.filter((g) => !g.inherited)
      for (const generate of generates) {
        const generateId = getGenerateId(node, generate.path)
        const generateFilename = join(path, generateId + '-generates.tgz')
        if (await environment.file.exists(generateFilename)) {
          const archiveFile = createWriteStream(generateFilename)
          const readable = await container.getArchive({
            path: generate.path,
          })

          await pipeline(readable, archiveFile)
        }
      }
    }
  )
}

async function archiveLocal(node: LocalWorkNode, path: string) {
  const archiveFile = createWriteStream(join(path, 'generates.tgz'))
  await pipeline(
    create(
      {
        cwd: node.cwd,
        gzip: true,
      },
      node.generates.filter((g) => !g.inherited).map((g) => relative(node.cwd, g.path))
    ),
    archiveFile
  )
}

export async function storeCache(path: string, workTree: WorkTree, environment: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(path, 'cache', node.id)

    await moveFiles(node, environment, function* () {
      yield { from: cachePath, to: sourceCacheDir }
    })

    if (isContainerWorkNode(node)) {
      await archiveContainer(environment, node, sourceCacheDir)
    } else {
      await archiveLocal(node, sourceCacheDir)
    }
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
