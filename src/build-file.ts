import { join, dirname, relative } from 'path'
import { EnvMap, loadEnvFile, overrideEnv } from './env'
import { RunArg } from './run-arg'
import { splitBy } from './string'
import { BuildFileConfig } from './config/build-file-config'
import { isDockerFileTaskConfig } from './config/docker-file-task-config'
import { remove } from './file/remove'
import { DockerTask } from './docker-task'
import { BuildFileReference } from './build-file-reference'
import { LocalTask } from './local-task'
import { parseBuildFile } from './file/parse'
import { Task } from './task'
import { BuildFileValidation } from './build-file-validation'
import { copy } from './file/copy'
import consola from 'consola'

export class BuildFile {
  constructor(
    public fileName: string,
    private buildFile: BuildFileConfig,
    private parentBuildFile: BuildFileReference | null
  ) {}

  hasParent(buildFile: BuildFile): boolean {
    return (
      !!this.parentBuildFile &&
      (this.parentBuildFile.buildFile.fileName === buildFile.fileName ||
        this.parentBuildFile.buildFile.hasParent(buildFile))
    )
  }

  getPath(): string[] {
    if (this.parentBuildFile) {
      return [...this.parentBuildFile.buildFile.getPath(), this.parentBuildFile.name]
    } else {
      return []
    }
  }

  async clean(arg: RunArg): Promise<void> {
    for (const task of this.getTasks()) {
      await task.clean(arg)
    }
    await this.cleanCache()
  }

  private getCacheDirectoryPath() {
    return join(dirname(this.fileName), '.hammerkit')
  }

  async cleanCache(): Promise<void> {
    await remove(this.getCacheDirectoryPath())
  }

  async restore(arg: RunArg, relativeDirectory: string, targetDirectory: string): Promise<void> {
    for (const task of this.getTasks()) {
      await task.restore(arg, relativeDirectory, targetDirectory)
    }

    const sourceCacheDir = join(
      process.cwd(),
      targetDirectory,
      relative(relativeDirectory, dirname(this.fileName)),
      '.hammerkit'
    )
    const cacheDir = this.getCacheDirectoryPath()
    copy(sourceCacheDir, cacheDir)
  }

  async store(arg: RunArg, relativeDirectory: string, targetDirectory: string): Promise<void> {
    for (const task of this.getTasks()) {
      await task.store(arg, relativeDirectory, targetDirectory)
    }

    const cacheDir = this.getCacheDirectoryPath()
    const targetCacheDir = join(
      process.cwd(),
      targetDirectory,
      relative(relativeDirectory, dirname(this.fileName)),
      '.hammerkit'
    )
    copy(cacheDir, targetCacheDir)
  }

  *validate(arg: RunArg): Generator<BuildFileValidation> {
    if (arg.hasCompleted(this.fileName)) {
      return
    }

    let count = 0
    for (const task of this.getTasks()) {
      for (const res of task.validate(arg)) {
        yield res
        count++
      }
    }

    for (const ref of this.getReferences()) {
      for (const res of ref.buildFile.validate(arg)) {
        yield res
      }
    }
    for (const include of this.getIncludes()) {
      for (const res of include.buildFile.validate(arg)) {
        yield res
      }
    }

    arg.complete(this.fileName, { generations: [], cached: false })
    if (count === 0) {
      consola.success(`${this.fileName} is valid`)
    }
  }

  getEnvironmentVariables(arg: RunArg): EnvMap {
    const envs = this.parentBuildFile ? this.parentBuildFile.buildFile.getEnvironmentVariables(arg) : arg.envs
    return overrideEnv(loadEnvFile(envs, dirname(this.fileName)), this.buildFile.envs)
  }

  getWorkingDirectory(): string {
    if (!this.parentBuildFile || this.parentBuildFile.type === 'reference') {
      return dirname(this.fileName)
    }
    return this.parentBuildFile.buildFile.getWorkingDirectory()
  }

  getInclude(name: string): BuildFileReference | null {
    const includes = this.buildFile.includes || {}
    const include = includes[name]
    if (!include) {
      return null
    }
    return {
      name,
      type: 'include',
      buildFile: parseBuildFile(join(dirname(this.fileName), include), {
        buildFile: this,
        type: 'include',
        name,
      }),
    }
  }

  *getIncludes(): Generator<BuildFileReference> {
    const includes = this.buildFile.includes || {}
    for (const name of Object.keys(includes)) {
      yield {
        name,
        type: 'include',
        buildFile: parseBuildFile(join(dirname(this.fileName), includes[name]), {
          buildFile: this,
          type: 'include',
          name,
        }),
      }
    }
  }

  getReference(name: string): BuildFileReference | null {
    const references = this.buildFile.references || {}
    const reference = references[name]
    if (!reference) {
      return null
    }
    return {
      name,
      type: 'reference',
      buildFile: parseBuildFile(join(dirname(this.fileName), reference), {
        buildFile: this,
        type: 'reference',
        name,
      }),
    }
  }

  *getReferences(): Generator<BuildFileReference> {
    const references = this.buildFile.references || {}
    for (const name of Object.keys(references)) {
      yield {
        name,
        type: 'reference',
        buildFile: parseBuildFile(join(dirname(this.fileName), references[name]), {
          buildFile: this,
          type: 'reference',
          name,
        }),
      }
    }
  }

  getTask(name: string): Task {
    const tasks = this.buildFile.tasks || {}
    const task = tasks[name]
    if (task) {
      if (isDockerFileTaskConfig(task)) {
        return new DockerTask(this, name, task)
      }

      return new LocalTask(this, name, task)
    }

    const [prefix, taskName] = splitBy(name, ':')
    if (prefix && taskName) {
      const include = this.getInclude(prefix)
      if (include) {
        return include.buildFile.getTask(taskName)
      }

      const ref = this.getReference(prefix)
      if (ref) {
        return ref.buildFile.getTask(taskName)
      }
    }

    throw new Error(`could not find task ${name}`)
  }

  *getTasks(): Generator<Task> {
    const tasks = this.buildFile.tasks || {}
    for (const name of Object.keys(tasks)) {
      const task = tasks[name]

      if (isDockerFileTaskConfig(task)) {
        yield new DockerTask(this, name, task)
      } else {
        yield new LocalTask(this, name, task)
      }
    }

    for (const ref of this.getReferences()) {
      if (ref.buildFile.hasParent(ref.buildFile)) {
        continue
      }
      for (const task of ref.buildFile.getTasks()) {
        yield task
      }
    }
  }
}
