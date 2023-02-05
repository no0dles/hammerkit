import { Environment } from './environment'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { dirname, join, relative, sep } from 'path'
import { moveFiles } from '../file/move-files'
import { convertToPosixPath } from './execute-docker'
import { existsVolume, removeVolume } from './get-docker-executor'
import { WorkTree } from '../planner/work-tree'
import { create, extract } from 'tar'
import { ContainerWorkNode, LocalWorkNode, WorkNode } from '../planner/work-node'
import { usingContainer } from '../docker/using-container'
import { CliCleanOptions } from '../cli'
import { getVolumeName } from '../planner/utils/plan-work-volume'
import { isContainerWorkItem, isLocalWorkTaskItem, WorkItem } from '../planner/work-item'

export async function restoreCache(path: string, workTree: WorkTree, environment: Environment): Promise<void> {
  for (const node of iterateWorkNodes(workTree.nodes)) {
    const cachePath = getCacheDirectory(node.id)
    const sourceCacheDir = join(path, node.id)

    await moveFiles(node, environment, function* () {
      yield { from: join(sourceCacheDir, 'stats.json'), to: join(cachePath, 'stats.json') }
      yield { from: join(sourceCacheDir, 'description.json'), to: join(cachePath, 'description.json') }
    })

    if (isContainerWorkItem(node)) {
      await restoreContainer(environment, node, sourceCacheDir)
    } else if (isLocalWorkTaskItem(node)) {
      await restoreLocal(environment, node.data, sourceCacheDir)
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

async function restoreContainer(environment: Environment, item: WorkItem<ContainerWorkNode>, path: string) {
  await usingContainer(
    environment,
    item,
    {
      Image: item.data.image,
      Tty: true,
      Entrypoint: 'sh',
      Cmd: ['-c', 'sleep 3600'],
      WorkingDir: convertToPosixPath(item.data.cwd),
      Labels: {
        app: 'hammerkit',
        'hammerkit-id': item.id,
        'hammerkit-pid': process.pid.toString(),
        'hammerkit-type': 'task',
      },
      HostConfig: {
        AutoRemove: true,
        Binds: [...item.data.volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`)],
      },
    },
    async (container) => {
      for (const generate of getGenerates(item.data, path)) {
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

async function archiveContainer(environment: Environment, item: WorkItem<ContainerWorkNode>, path: string) {
  await usingContainer(
    environment,
    item,
    {
      Image: item.data.image,
      Tty: true,
      Entrypoint: 'sh',
      Cmd: ['-c', 'sleep 3600'],
      WorkingDir: convertToPosixPath(item.data.cwd),
      Labels: {
        app: 'hammerkit',
        'hammerkit-id': item.id,
        'hammerkit-pid': process.pid.toString(),
        'hammerkit-type': 'task',
      },
      HostConfig: {
        AutoRemove: true,
        Binds: [...item.data.volumes.map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`)],
      },
    },
    async (container) => {
      for (const generatedArchive of getGenerates(item.data, path)) {
        const readable = await container.getArchive({
          path: generatedArchive.path,
        })

        await environment.file.writeStream(generatedArchive.filename, readable)
      }
    }
  )
}

async function archiveLocal(environment: Environment, node: WorkItem<LocalWorkNode>, path: string) {
  for (const generatedArchive of getGenerates(node.data, path)) {
    await environment.file.writeStream(
      generatedArchive.filename,
      create(
        {
          cwd: node.data.cwd,
          gzip: true,
        },
        [relative(node.data.cwd, generatedArchive.path)]
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

    if (isContainerWorkItem(node)) {
      await archiveContainer(environment, node, sourceCacheDir)
    } else if (isLocalWorkTaskItem(node)) {
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
    for (const generate of node.data.generates) {
      if (generate.inherited) {
        continue
      }

      const volumeName = getVolumeName(generate.path)
      const volumeExists = await existsVolume(environment, volumeName)
      if (volumeExists) {
        await removeVolume(environment, node.status, volumeName)
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

  if (options.service) {
    for (const service of iterateWorkServices(workTree.services)) {
      if (service.data.type !== 'container-service') {
        continue
      }

      for (const volume of service.data.volumes) {
        const volumeExists = await existsVolume(environment, volume.name)
        if (!volumeExists) {
          continue
        }

        await removeVolume(environment, service.status, volume.name)
      }
    }
  }
}
