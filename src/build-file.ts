import { join, dirname } from 'path'
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

  async cleanCache(): Promise<void> {
    const cacheDir = join(dirname(this.fileName), '.hammerkit')
    await remove(cacheDir)
  }

  async restore(directory: string): Promise<void> {
    for (const task of this.getTasks()) {
      await task.restore(directory)
    }
  }

  async store(directory: string): Promise<void> {
    for (const task of this.getTasks()) {
      await task.store(directory)
    }
  }

  *validate(arg: RunArg): Generator<BuildFileValidation> {
    for (const task of this.getTasks()) {
      for (const res of task.validate(arg)) {
        yield res
      }
    }
    for (const ref of this.getReferences()) {
      for (const res of ref.buildFile.validate(arg)) {
        // TODO child?
        yield res
      }
    }
    for (const include of this.getIncludes()) {
      // TODO child?
      for (const res of include.buildFile.validate(arg)) {
        yield res
      }
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
      }
      yield new LocalTask(this, name, task)
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
