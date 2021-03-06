import { readBuildFile } from './read-build-file'
import { BuildFile } from './build-file'
import { Environment } from '../executer/environment'

export function getBuildFile(fileName: string, context: Environment): Promise<BuildFile> {
  return readBuildFile(fileName, {}, context)
}
