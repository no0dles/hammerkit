import { Environment } from './environment'
import { iterateWorkTasks, iterateWorkServices } from '../planner/utils/plan-work-tasks'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { dirname, join, relative, sep } from 'path'
import { moveFiles } from '../file/move-files'
import { convertToPosixPath } from './execute-docker'
import { existsVolume, removeVolume } from './get-docker-executor'
import { WorkTree } from '../planner/work-tree'
import { create, extract } from 'tar'
import { ContainerWorkTask, LocalWorkTask, WorkTask } from '../planner/work-task'
import { usingContainer } from '../docker/using-container'
import { CliCleanOptions } from '../cli'
import { getVolumeName } from '../planner/utils/plan-work-volume'
import { isContainerWorkItem, isLocalWorkTaskItem, WorkItem } from '../planner/work-item'

export async function restoreCache(path: string, workTree: WorkTree, environment: Environment): Promise<void> {
  for (const task of iterateWorkTasks(workTree)) {
    const cachePath = getCacheDirectory(task.cacheId())
    const sourceCacheDir = join(path, task.cacheId())

    await moveFiles(task, environment, function* () {
      yield { from: join(sourceCacheDir, 'stats.json'), to: join(cachePath, 'stats.json') }
      yield { from: join(sourceCacheDir, 'description.json'), to: join(cachePath, 'description.json') }
    })

    if (isContainerWorkItem(task)) {
      await restoreContainer(environment, task, sourceCacheDir)
    } else if (isLocalWorkTaskItem(task)) {
      await restoreLocal(environment, task.data, sourceCacheDir)
    }
  }
}

async function restoreLocal(environment: Environment, task: LocalWorkTask, path: string) {
  for (const generate of getGenerates(task, path)) {
    if (await environment.file.exists(generate.filename)) {
      await extract({
        file: generate.filename,
        cwd: task.cwd,
      })
    }
  }
}

async function restoreContainer(environment: Environment, item: WorkItem<ContainerWorkTask>, path: string) {
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
        'hammerkit-id': item.cacheId(),
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

function* getGenerates(task: WorkTask, path: string) {
  const generates = task.generates.filter((g) => !g.inherited)
  for (const generate of generates) {
    const generateId = relative(task.cwd, generate.path).split(sep).join('-')
    yield {
      filename: join(path, generateId + '-generates.tgz'),
      path: generate.path,
    }
  }
}

async function archiveContainer(environment: Environment, item: WorkItem<ContainerWorkTask>, path: string) {
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
        'hammerkit-id': item.cacheId(),
        'hammerkit-pid': process.pid.toString(),
        'hammerkit-type': 'task',
      },
      HostConfig: {
        AutoRemove: true,
        Binds: [
          ...item.data.volumes
            .filter((v) => !v.inherited)
            .map((v) => `${v.name}:${convertToPosixPath(v.containerPath)}`),
          ...item.data.generates
            .filter((v) => !v.inherited && !v.isFile)
            .map((v) => `${v.volumeName}:${convertToPosixPath(v.path)}`),
        ],
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

async function archiveLocal(environment: Environment, task: WorkItem<LocalWorkTask>, path: string) {
  for (const generatedArchive of getGenerates(task.data, path)) {
    await environment.file.writeStream(
      generatedArchive.filename,
      create(
        {
          cwd: task.data.cwd,
          gzip: true,
        },
        [relative(task.data.cwd, generatedArchive.path)]
      )
    )
  }
}

export async function storeCache(path: string, workTree: WorkTree, environment: Environment): Promise<void> {
  for (const task of iterateWorkTasks(workTree)) {
    const cachePath = getCacheDirectory(task.cacheId())
    const sourceCacheDir = join(path, task.cacheId())

    await moveFiles(task, environment, function* () {
      yield { from: join(cachePath, 'stats.json'), to: join(sourceCacheDir, 'stats.json') }
      yield { from: join(cachePath, 'description.json'), to: join(sourceCacheDir, 'description.json') }
    })

    if (isContainerWorkItem(task)) {
      await archiveContainer(environment, task, sourceCacheDir)
    } else if (isLocalWorkTaskItem(task)) {
      await archiveLocal(environment, task, sourceCacheDir)
    }
  }
}

export async function cleanCache(
  workTree: WorkTree,
  environment: Environment,
  options: CliCleanOptions
): Promise<void> {
  for (const task of iterateWorkTasks(workTree)) {
    for (const generate of task.data.generates) {
      if (generate.inherited) {
        continue
      }

      const volumeName = getVolumeName(generate.path)
      const volumeExists = await existsVolume(environment, volumeName)
      if (volumeExists) {
        await removeVolume(environment, task.status, volumeName)
      } else {
        task.status.write('info', `generate ${generate} has no volume ${volumeName}`)
      }

      task.status.write('info', `remove local directory ${generate.path}`)
      await environment.file.remove(generate.path)
    }

    const cachePath = getCacheDirectory(task.cacheId())
    if (await environment.file.exists(cachePath)) {
      task.status.write('info', `remove cache ${cachePath}`)
      await environment.file.remove(cachePath)
    }
  }

  if (options.service) {
    for (const service of iterateWorkServices(workTree)) {
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
