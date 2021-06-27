import { readBuildFile } from './read-build-file'
import { BuildFile } from './build-file'

export function parseBuildFile(fileName: string): BuildFile {
  return readBuildFile(fileName, {})
}
