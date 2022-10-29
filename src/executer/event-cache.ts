import { Environment } from './environment'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { dirname, join, relative, sep } from 'path'
import { moveFiles } from '../file/move-files'
import { convertToPosixPath, getContainerVolumes, getDocker, getVolumeName } from './execute-docker'
import { existsVolume } from './get-docker-executor'
import { WorkTree } from '../planner/work-tree'
import { create, extract } from 'tar'
import { ContainerWorkNode, isContainerWorkNode, LocalWorkNode, WorkNode } from '../planner/work-node'
import { usingContainer } from '../docker/using-container'
import { isContainerWorkService } from '../planner/work-service'
import { CliCleanOptions } from '../cli'

export async function restoreCache(path: string, workTree: WorkTree, environment: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(path, node.id)

    await moveFiles(node, environment, function* () {
      yield { from: join(sourceCacheDir, 'stats.json'), to: join(cachePath, 'stats.json') }
      yield { from: join(sourceCacheDir, 'description.json'), to: join(cachePath, 'description.json') }
    })

    if (isContainerWorkNode(node)) {
      await restoreContainer(environment, node, sourceCacheDir)
    } else {
      await restoreLocal(environment, node, sourceCacheDir)
    }
  }
}

async function restoreLocal(environment: Environment, node: LocalWorkNode, path: string) {
  for (const generate of getGenerates(node, path)) {
    if (await environment.file.exists(generate.filename)) {
      await extract({
        file: generate.filename,
        cwd: node.cwd,
      })
    }
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

      for (const generate of getGenerates(node, path)) {
        if (await environment.file.exists(generate.filename)) {
          await container.putArchive(environment.file.readStream(generate.filename), {
            path: dirname(generate.path),
          })
        }
      }
    }
  )
}

function* getGenerates(node: WorkNode, path: string) {
  const generates = node.generates.filter((g) => !g.inherited)
  for (const generate of generates) {
    const generateId = relative(node.cwd, generate.path).split(sep).join('-')
    yield {
      filename: join(path, generateId + '-generates.tgz'),
      path: generate.path,
    }
  }
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
      for (const generatedArchive of getGenerates(node, path)) {
        const readable = await container.getArchive({
          path: generatedArchive.path,
        })

        await environment.file.writeStream(generatedArchive.filename, readable)
      }
    }
  )
}

async function archiveLocal(environment: Environment, node: LocalWorkNode, path: string) {
  for (const generatedArchive of getGenerates(node, path)) {
    await environment.file.writeStream(
      generatedArchive.filename,
      create(
        {
          cwd: node.cwd,
          gzip: true,
        },
        [relative(node.cwd, generatedArchive.path)]
      )
    )
  }
}

export async function storeCache(path: string, workTree: WorkTree, environment: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(path, node.id)

    await moveFiles(node, environment, function* () {
      yield { from: join(cachePath, 'stats.json'), to: join(sourceCacheDir, 'stats.json') }
      yield { from: join(cachePath, 'description.json'), to: join(sourceCacheDir, 'description.json') }
    })

    if (isContainerWorkNode(node)) {
      await archiveContainer(environment, node, sourceCacheDir)
    } else {
      await archiveLocal(environment, node, sourceCacheDir)
    }
  }
}

export async function cleanCache(
  workTree: WorkTree,
  environment: Environment,
  options: CliCleanOptions
): Promise<void> {
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

  if (options.service) {
    for (const service of iterateWorkServices(workTree.services)) {
      if (!isContainerWorkService(service)) {
        continue
      }

      const nodeStatus = environment.status.service(service)
      const docker = await getDocker(nodeStatus)
      for (const volume of service.volumes) {
        const volumeExists = await existsVolume(docker, volume.name)
        if (!volumeExists) {
          continue
        }

        nodeStatus.write('info', `remove volume ${volume.name}`)
        const containerVolume = await docker.getVolume(volume.name)
        await containerVolume.remove()
      }
    }
  }
}
