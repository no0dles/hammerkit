import { ParsedReference } from './parsedReference'
import { ParsedTask } from './parse'
import { EnvMap } from './env'
import { RunArg } from './run-arg'
import { BuildFileValidation } from './parsedBuildFileTask'
import { BuildFileReference } from './buildFileReference'

export interface ParsedBuildFile {
  fileName: string

  hasParent(buildFile: ParsedBuildFile): boolean
  getPath(): string[]

  getTasks(): Generator<ParsedTask>

  getTask(name: string): ParsedTask

  getEnvironmentVariables(arg: RunArg): EnvMap

  getReferences(): Generator<ParsedReference>

  getReference(name: string): ParsedReference | null

  getIncludes(): Generator<ParsedReference>

  getInclude(name: string): ParsedReference | null

  validate(arg: RunArg): Generator<BuildFileValidation>

  clean(): Promise<void>

  store(directory: string): Promise<void>

  restore(directory: string): Promise<void>

  getWorkingDirectory(): string
}
