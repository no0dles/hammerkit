import { readBuildFile } from './read-build-file'
import { BuildFile } from './build-file'
import { Environment } from '../run-arg'

export function parseBuildFile(fileName: string, context: Environment): Promise<BuildFile> {
  return readBuildFile(fileName, {}, context)
}
