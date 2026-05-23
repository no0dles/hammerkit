import { Environment } from './environment'
import { iterateWorkTasks, iterateWorkServices } from '../planner/utils/plan-work-tasks'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { join, relative, sep } from 'path'
import { moveFiles } from '../file/move-files'
import { WorkTree } from '../planner/work-tree'
import { ContainerWorkTask, LocalWorkTask } from '../planner/work-task'
import { ContainerWorkService } from '../planner/work-service'

export async function restoreCache(environment: Environment, path: string, workTree: WorkTree): Promise<void> {
  for (const task of iterateWorkTasks(workTree)) {
    const cachePath = getCacheDirectory(task.id())
    const sourceCacheDir = join(path, task.id())

    // TODO move into local runtime
    await moveFiles(task, environment, function* () {
      yield { from: join(sourceCacheDir, 'stats.json'), to: join(cachePath, 'stats.json') }
      yield { from: join(sourceCacheDir, 'description.json'), to: join(cachePath, 'description.json') }
    })

    await task.runtime.restore(environment, sourceCacheDir)
  }

  for (const service of iterateWorkServices(workTree)) {
    const cachePath = getCacheDirectory(service.id())
    const sourceCacheDir = join(path, service.id())

    // TODO move into local runtime
    await moveFiles(service, environment, function* () {
      yield { from: join(sourceCacheDir, 'stats.json'), to: join(cachePath, 'stats.json') }
      yield { from: join(sourceCacheDir, 'description.json'), to: join(cachePath, 'description.json') }
    })

    await service.runtime.restore(environment, sourceCacheDir)
  }
}

export function* getArchivePaths(task: LocalWorkTask | ContainerWorkTask | ContainerWorkService, path: string) {
  if (task.type === 'container-service') {
    for (const volume of task.volumes.filter((v) => !v.inherited)) {
      yield {
        filename: join(path, volume.name + '-volume.tgz'),
        path: volume.containerPath,
      }
    }
  } else {
    for (const generate of task.generates.filter((g) => !g.inherited)) {
      const generateId = relative(task.cwd, generate.path).split(sep).join('-')
      yield {
        filename: join(path, generateId + '-generates.tgz'),
        path: generate.path,
      }
    }
  }
}

export async function storeCache(environment: Environment, path: string, workTree: WorkTree): Promise<void> {
  for (const task of iterateWorkTasks(workTree)) {
    const cachePath = getCacheDirectory(task.id())
    const sourceCacheDir = join(path, task.id())

    await moveFiles(task, environment, function* () {
      yield { from: join(cachePath, 'stats.json'), to: join(sourceCacheDir, 'stats.json') }
      yield { from: join(cachePath, 'description.json'), to: join(sourceCacheDir, 'description.json') }
    })

    await environment.file.createDirectory(sourceCacheDir)
    await task.runtime.archive(environment, sourceCacheDir)
  }

  for (const service of iterateWorkServices(workTree)) {
    const cachePath = getCacheDirectory(service.id())
    const sourceCacheDir = join(path, service.id())

    await moveFiles(service, environment, function* () {
      yield { from: join(cachePath, 'stats.json'), to: join(sourceCacheDir, 'stats.json') }
      yield { from: join(cachePath, 'description.json'), to: join(sourceCacheDir, 'description.json') }
    })

    await environment.file.createDirectory(sourceCacheDir)
    await service.runtime.archive(environment, sourceCacheDir)
  }
}

export async function cleanCache(workTree: WorkTree, environment: Environment): Promise<void> {
  for (const task of iterateWorkTasks(workTree)) {
    await task.runtime.remove(environment)

    const cachePath = getCacheDirectory(task.id())
    if (await environment.file.exists(cachePath)) {
      task.status.write('info', `remove cache ${cachePath}`)
      await environment.file.remove(cachePath)
    }
  }

  for (const service of iterateWorkServices(workTree)) {
    await service.runtime.remove(environment)
  }
}
