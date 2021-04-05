import { RunArg } from './run-arg'
import { ParsedTask } from './parse'
import { EnvMap } from './env'
import { ParsedBuildFile } from './parsedBuildFile'

export type ParsedBuildFileTaskCmd =
  | string
  | {
      run: ParsedTask
      envs: EnvMap
    }

export interface BuildFileValidation {
  buildFile: ParsedBuildFile
  task?: ParsedTask
  message: string
  type: 'error' | 'warn'
}

export interface ParsedBuildFileTask {
  getId(): string

  getRelativeName(): string

  getAbsoluteName(): string

  getDescription(): string

  getCommands(arg: RunArg): Generator<ParsedBuildFileTaskCmd>

  getSources(): Generator<{ relativePath: string; absolutePath: string }>

  getGenerates(): Generator<{ relativePath: string; absolutePath: string }>

  getEnvironmentVariables(arg: RunArg): EnvMap

  getWorkingDirectory(): string

  updateCache(): Promise<void>

  isCached(): Promise<boolean>

  getDependencies(): Generator<ParsedTask>

  execute(arg: RunArg): Promise<void>

  store(directory: string): Promise<void>

  restore(directory: string): Promise<void>

  validate(arg: RunArg): Generator<BuildFileValidation>

  clean(): Promise<void>
}
