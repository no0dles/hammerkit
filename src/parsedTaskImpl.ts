import { ParsedBuildFile } from './parsedBuildFile'
import { RunArg } from './run-arg'
import { BuildFileTask } from './config'
import { dirname, join, relative, resolve } from 'path'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'fs'
import { ParsedTask } from './parse'
import { copy } from './copy'
import {
  BuildFileValidation,
  FileTaskExecution,
  Generation,
  ParsedBuildFileTask,
  ParsedBuildFileTaskCmd,
  SourceEntry,
  SourceEntryFilterFn,
} from './parsedBuildFileTask'
import { EnvMap, overrideEnv } from './env'
import { remove } from './remove'
import { splitBy } from './string'
import { Minimatch } from 'minimatch'

export abstract class ParsedTaskImpl implements ParsedBuildFileTask {
  constructor(private buildFile: ParsedBuildFile, private name: string, protected task: BuildFileTask) {}

  abstract executeTask(arg: RunArg, generations: Generation[]): Promise<void>

  abstract get taskConfigKeys(): string[]

  abstract get taskCacheValues(): any[]

  async execute(arg: RunArg): Promise<FileTaskExecution> {
    const result: FileTaskExecution = {
      cached: false,
      generations: [],
    }

    const id = this.getId()
    const prevResult = arg.hasCompleted(id)
    if (prevResult) {
      return prevResult
    }

    for (const generate of this.getGenerates()) {
      result.generations.push(generate)
    }

    const name = this.getAbsoluteName()
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

    let allDependenciesAreCached = true
    for (const dep of this.getDependencies()) {
      const depResult = await dep.execute(arg)
      if (depResult.generations.length > 0) {
        result.generations.push(...depResult.generations)
      }
      if (!depResult.cached && dep.canBeCached()) {
        allDependenciesAreCached = false
      }
    }

    if (allDependenciesAreCached) {
      if (arg.disableCache) {
        arg.logger.withTag(name).debug('caching disabled')
      } else if (await this.isCached(arg)) {
        arg.logger.withTag(name).debug('cache up to date')
        result.cached = true
        return result
      }
    } else {
      arg.logger.withTag(name).debug('dependency changed, cache may not apply')
    }

    await this.executeTask(arg, result.generations)
    await this.updateCache()

    arg.complete(this.getId(), result)

    return result
  }

  getId(): string {
    return `${this.buildFile.fileName};${this.getRelativeName()}`
  }

  getDescription(): string {
    return (this.task.description || '').trim()
  }

  *getCommands(arg: RunArg): Generator<ParsedBuildFileTaskCmd> {
    const envs = this.getEnvironmentVariables(arg)
    for (const cmd of this.task.cmds || []) {
      if (typeof cmd === 'string') {
        yield envs.escape(cmd).trim()
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

  *getSources(): Generator<SourceEntry> {
    const workDirectory = this.getWorkingDirectory()
    for (const source of this.task.src || []) {
      const wildcardIndex = source.indexOf('*')
      if (wildcardIndex >= 0) {
        const matcher = new Minimatch(source, { dot: true })
        const ignore: SourceEntryFilterFn = (fileName) => {
          return !matcher.match(fileName)
        }
        if (wildcardIndex === 0) {
          yield {
            relativePath: '.',
            absolutePath: workDirectory,
            ignore,
          }
        } else {
          const [prefix] = splitBy(source, '*')
          yield {
            relativePath: prefix.replace(/\/$/, ''),
            absolutePath: join(workDirectory, prefix),
            ignore,
          }
        }
      } else {
        yield {
          relativePath: source,
          absolutePath: join(workDirectory, source),
          ignore: () => false,
        }
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

    const taskKeys = Object.keys(this.task)
    for (const key of this.taskConfigKeys) {
      const tk = taskKeys.find((tk) => tk === key)
      if (tk) {
        taskKeys.splice(taskKeys.indexOf(tk), 1)
      }
    }

    for (const unknownKey of taskKeys) {
      yield {
        type: 'error',
        buildFile: this.buildFile,
        message: `${unknownKey} is an unknown configuration`,
        task: this,
      }
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

  private getTaskCacheFile() {
    return join(this.getWorkingDirectory(), '.hammerkit', this.name + '.task')
  }

  async updateCache(): Promise<void> {
    const cacheFile = this.getCacheFile()
    const cacheDir = dirname(cacheFile)

    if (!existsSync(cacheDir)) {
      mkdirSync(cacheDir, { recursive: true })
    }

    const taskCacheFile = this.getTaskCacheFile()
    const taskCacheStream = createWriteStream(taskCacheFile)
    for (const cache of this.getCacheTaskSummary()) {
      taskCacheStream.write(`${cache}\n`)
    }
    await new Promise<void>((resolve, reject) => {
      taskCacheStream.on('error', reject)
      taskCacheStream.on('finish', resolve)
      taskCacheStream.end()
    })

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

  canBeCached(): boolean {
    return !!this.task.src && this.task.src.length > 0
  }

  async isCached(arg: RunArg): Promise<boolean> {
    if (!this.canBeCached()) {
      arg.logger.withTag(this.getAbsoluteName()).debug('cant be cached, missing src')
      return false
    }

    if (this.hasTaskChanged()) {
      arg.logger.withTag(this.getAbsoluteName()).debug('cache outdated, task definition changed')
      return false
    }

    const cacheSummary = this.getCacheSummary()
    if (!cacheSummary) {
      arg.logger.withTag(this.getAbsoluteName()).debug('no cache found')
      return false
    }

    const sourceSummary = this.getSourceSummary()
    for (const entry of sourceSummary) {
      const cacheEntry = cacheSummary[entry.fileName]
      if (cacheEntry !== entry.lastModified) {
        arg.logger.withTag(this.getAbsoluteName()).debug(`cache src ${entry.fileName} changed`)
        return false
      }
    }

    return true
  }

  *getSourceSummary(): Generator<CacheEntry> {
    for (const src of this.getSources()) {
      const stats = statSync(src.absolutePath)

      if (stats.isDirectory()) {
        for (const subFile of this.extendSourceSummary(src.absolutePath, src)) {
          yield subFile
        }
      } else {
        if (!src.ignore(src.relativePath)) {
          yield { fileName: src.absolutePath, lastModified: stats.mtimeMs }
        }
      }
    }
  }

  *extendSourceSummary(directory: string, src: SourceEntry): Generator<CacheEntry> {
    const files = readdirSync(directory)
    for (const file of files) {
      if (file === '.hammerkit') {
        continue
      }

      const fileName = join(directory, file)
      const stats = statSync(fileName)
      const relativeFileName = relative(src.absolutePath, fileName)
      if (src.ignore(relativeFileName)) {
        continue
      }

      if (stats.isDirectory()) {
        for (const subDir of this.extendSourceSummary(fileName, src)) {
          yield subDir
        }
      } else if (stats.isFile()) {
        yield { fileName, lastModified: stats.mtimeMs }
      }
    }
  }

  hasTaskChanged(): boolean {
    const cacheFile = this.getTaskCacheFile()
    if (!existsSync(cacheFile)) {
      return false
    }
    const content = readFileSync(cacheFile).toString()
    const lines = content.split(/\r?\n/)
    let i = 0
    for (const current of this.getCacheTaskSummary()) {
      if (current !== lines[i] && !(current === undefined && lines[i] === 'undefined')) {
        return true
      }
      i++
    }

    return false
  }

  *getCacheTaskSummary(): Generator<string> {
    for (const value of this.taskCacheValues) {
      yield JSON.stringify(value)
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
