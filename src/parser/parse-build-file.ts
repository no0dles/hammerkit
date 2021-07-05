import { readBuildFile } from './read-build-file'
import { BuildFile } from './build-file'
import {Context} from '../run-arg';

export function parseBuildFile(fileName: string, context: Context): Promise<BuildFile> {
  return readBuildFile(fileName, {}, context)
}
