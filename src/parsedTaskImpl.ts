import { ParsedBuildFile } from './parsedBuildFile'
import { RunArg } from './run-arg'
import { BuildFileTask } from './config'
import { dirname, join, relative, resolve } from 'path'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { ParsedTask } from './parse'
import { copy } from './copy'
import { BuildFileValidation, ParsedBuildFileTask, ParsedBuildFileTaskCmd } from './parsedBuildFileTask'
import { EnvMap, overrideEnv } from './env'
import { remove } from './remove'

export abstract class ParsedTaskImpl implements ParsedBuildFileTask {
  constructor(private buildFile: ParsedBuildFile, private name: string, private task: BuildFileTask) {}

  abstract executeTask(arg: RunArg): Promise<void>

  async execute(arg: RunArg): Promise<void> {
    const name = this.getRelativeName()
    let errors = 0

    for (const validate of this.validate(arg)) {
      if (validate.type === 'error') {
        arg.logger.withTag(name).withTag(validate.buildFile.fileName).error(validate.message)
        errors++
      } else if (validate.type === 'warn') {
        arg.logger.withTag(name).withTag(validate.buildFile.fileName).warn(validate.message)
      }
    }

    if (errors > 0) {
      throw new Error(`${errors} validation errors`)
    }

    for (const dep of this.getDependencies()) {
      await dep.execute(arg)
    }

    if (!arg.disableCache && (await this.isCached())) {
      arg.logger.withTag(name).debug('skipped is cached')
      return
    }

    await this.executeTask(arg)
    await this.updateCache()
  }

  getId(): string {
    return `${this.buildFile.fileName};${this.getRelativeName()}`
  }

  getDescription(): string {
    return this.task.description || ''
  }

  *getCommands(arg: RunArg): Generator<ParsedBuildFileTaskCmd> {
    const envs = this.getEnvironmentVariables(arg)
    for (const cmd of this.task.cmds || []) {
      if (typeof cmd === 'string') {
        yield envs.escape(cmd)
      } else {
        yield {
          run: this.buildFile.getTask(cmd.run),
          envs: overrideEnv(envs, cmd.envs),
        }
      }
    }
  }

  *getDependencies(): Generator<ParsedTask> {
    const deps = this.task.deps || []
    for (const dep of deps) {
      yield this.buildFile.getTask(dep)
    }
  }

  getEnvironmentVariables(arg: RunArg): EnvMap {
    return overrideEnv(this.buildFile.getEnvironmentVariables(arg), this.task.envs)
  }

  *getGenerates(): Generator<{ relativePath: string; absolutePath: string }> {
    const workDirectory = this.getWorkingDirectory()
    for (const source of this.task.generates || []) {
      yield {
        relativePath: source,
        absolutePath: join(workDirectory, source),
      }
    }
  }

  getRelativeName(): string {
    return this.name
  }

  getAbsoluteName(): string {
    return [...this.buildFile.getPath(), this.name].join(':')
  }

  *getSources(): Generator<{ relativePath: string; absolutePath: string }> {
    const workDirectory = this.getWorkingDirectory()
    for (const source of this.task.src || []) {
      yield {
        relativePath: source,
        absolutePath: join(workDirectory, source),
      }
    }
  }

  getWorkingDirectory(): string {
    return this.buildFile.getWorkingDirectory()
  }

  *validate(arg: RunArg): Generator<BuildFileValidation> {
    const description = this.getDescription()
    if (!description) {
      yield { type: 'warn', buildFile: this.buildFile, message: `missing description`, task: this }
    }

    for (const src of this.getSources()) {
      if (!existsSync(src.absolutePath)) {
        yield {
          type: 'warn',
          buildFile: this.buildFile,
          message: `src ${src.relativePath} does not exist`,
          task: this,
        }
      }
    }

    try {
      this.getEnvironmentVariables(arg)
    } catch (e) {
      yield {
        type: 'error',
        buildFile: this.buildFile,
        task: this,
        message: e.message,
      }
    }

    let depCount = 0
    for (const dep of this.getDependencies()) {
      depCount++
      if (!arg.hasParent(dep.getId())) {
        for (const validate of dep.validate(arg.child(this.getId(), this.getRelativeName()))) {
          yield validate
        }
      } else {
        yield {
          type: 'error',
          buildFile: this.buildFile,
          task: this,
          message: `cycle detected ${arg.getPath(this.getRelativeName())}`,
        }
      }
    }

    let cmdCount = 0
    for (const cmd of this.getCommands(arg)) {
      cmdCount++
      if (typeof cmd !== 'string') {
        if (!arg.hasParent(cmd.run.getId())) {
          for (const validate of cmd.run.validate(arg.child(this.getId(), this.getRelativeName()))) {
            yield validate
          }
        } else {
          yield {
            type: 'error',
            buildFile: this.buildFile,
            task: this,
            message: `cycle detected ${arg.getPath(this.getRelativeName())}`,
          }
        }
      }
    }

    if (cmdCount === 0 && depCount === 0) {
      yield {
        type: 'warn',
        buildFile: this.buildFile,
        task: this,
        message: 'task is empty',
      }
    }
  }

  async restore(directory: string): Promise<void> {
    for (const generate of this.getGenerates()) {
      const sourcePath = join(directory, this.getRelativeName(), generate.relativePath)
      const targetPath = generate.absolutePath

      if (!existsSync(sourcePath)) {
        continue
      }

      copy(sourcePath, targetPath)
    }
  }

  async store(directory: string): Promise<void> {
    for (const generate of this.getGenerates()) {
      const sourcePath = generate.absolutePath
      const targetPath = join(directory, this.getRelativeName(), generate.relativePath)

      if (!existsSync(sourcePath)) {
        continue
      }

      copy(sourcePath, targetPath)
    }
  }

  async clean(): Promise<void> {
    for (const generate of this.getGenerates()) {
      await remove(generate.absolutePath)
    }
  }

  private getCacheFile() {
    return join(this.getWorkingDirectory(), '.hammerkit', this.name)
  }

  async updateCache(): Promise<void> {
    const cacheFile = this.getCacheFile()
    const cacheDir = dirname(cacheFile)

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true })
    }

    const sourceSummary = this.getSourceSummary()
    const fileStream = createWriteStream(cacheFile)
    const workingDirectory = this.getWorkingDirectory()

    let hasWrittenEntry = false
    for (const entry of sourceSummary) {
      fileStream.write(`${relative(workingDirectory, entry.fileName)}=${entry.lastModified}\n`)
      hasWrittenEntry = true
    }
    if (hasWrittenEntry) {
      await new Promise<void>((resolve, reject) => {
        fileStream.on('error', reject)
        fileStream.on('finish', resolve)
        fileStream.end()
      })
    } else {
      fileStream.end()
    }
  }

  async isCached(): Promise<boolean> {
    // TODO when mounts change, isuptodate=false
    // TODO when task content changes

    if (!this.task.src || this.task.src.length === 0) {
      return false
    }

    const cacheSummary = this.getCacheSummary()
    if (!cacheSummary) {
      return false
    }

    const sourceSummary = this.getSourceSummary()
    for (const entry of sourceSummary) {
      const cacheEntry = cacheSummary[entry.fileName]
      if (cacheEntry !== entry.lastModified) {
        return false
      }
    }

    return true
  }

  *getSourceSummary(): Generator<CacheEntry> {
    for (const src of this.getSources()) {
      const stats = statSync(src.absolutePath)
      yield { fileName: src.absolutePath, lastModified: stats.mtimeMs }

      if (stats.isDirectory()) {
        for (const subFile of this.extendSourceSummary(src.absolutePath)) {
          yield subFile
        }
      }
    }
  }

  *extendSourceSummary(directory: string): Generator<CacheEntry> {
    const files = readdirSync(directory)
    for (const file of files) {
      const fileName = join(directory, file)
      const stats = statSync(fileName)
      yield { fileName, lastModified: stats.mtimeMs }
      if (stats.isDirectory()) {
        for (const subDir of this.extendSourceSummary(fileName)) {
          yield subDir
        }
      }
    }
  }

  getCacheSummary(): { [key: string]: number } | false {
    const cacheFile = this.getCacheFile()
    const workingDirectory = this.getWorkingDirectory()
    if (!existsSync(cacheFile)) {
      return false
    }
    const content = readFileSync(cacheFile).toString()
    const lines = content.split(/\r?\n/)
    return lines.reduce<{ [key: string]: number }>((map, line) => {
      const [key, value] = line.split('=')
      const path = resolve(workingDirectory, key)
      map[path] = parseFloat(value)
      return map
    }, {})
  }
}

export interface CacheEntry {
  fileName: string
  lastModified: number
}
