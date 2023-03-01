import { Environment } from './environment'
import { iterateWorkTasks, iterateWorkServices } from '../planner/utils/plan-work-tasks'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { join, relative, sep } from 'path'
import { moveFiles } from '../file/move-files'
import { WorkTree } from '../planner/work-tree'
import { WorkTask } from '../planner/work-task'

export async function restoreCache(environment: Environment, path: string, workTree: WorkTree): Promise<void> {
  for (const task of iterateWorkTasks(workTree)) {
    const cachePath = getCacheDirectory(task.cacheId())
    const sourceCacheDir = join(path, task.cacheId())

    await moveFiles(task, environment, function* () {
      yield { from: join(sourceCacheDir, 'stats.json'), to: join(cachePath, 'stats.json') }
      yield { from: join(sourceCacheDir, 'description.json'), to: join(cachePath, 'description.json') }
    })

    await task.runtime.restore(environment, sourceCacheDir)
  }
}

export function* getArchivePaths(task: WorkTask, path: string) {
  const generates = task.generates.filter((g) => !g.inherited)
  for (const generate of generates) {
    const generateId = relative(task.cwd, generate.path).split(sep).join('-')
    yield {
      filename: join(path, generateId + '-generates.tgz'),
      path: generate.path,
    }
  }
}

export async function storeCache(environment: Environment, path: string, workTree: WorkTree): Promise<void> {
  for (const task of iterateWorkTasks(workTree)) {
    const cachePath = getCacheDirectory(task.cacheId())
    const sourceCacheDir = join(path, task.cacheId())

    await moveFiles(task, environment, function* () {
      yield { from: join(cachePath, 'stats.json'), to: join(sourceCacheDir, 'stats.json') }
      yield { from: join(cachePath, 'description.json'), to: join(sourceCacheDir, 'description.json') }
    })

    await task.runtime.archive(environment, sourceCacheDir)
  }
}

export async function cleanCache(workTree: WorkTree, environment: Environment): Promise<void> {
  for (const task of iterateWorkTasks(workTree)) {
    await task.runtime.remove(environment)

    const cachePath = getCacheDirectory(task.cacheId())
    if (await environment.file.exists(cachePath)) {
      task.status.write('info', `remove cache ${cachePath}`)
      await environment.file.remove(cachePath)
    }
  }

  for (const service of iterateWorkServices(workTree)) {
    await service.runtime.remove(environment)
  }
}
