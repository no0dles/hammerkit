import { dirname, join } from 'path'
import { existsSync } from 'fs'
import { readBuildFile } from './read-build-file'
import { BuildFile } from './build-file'

export function parseBuildFileReferences(
  type: string,
  fileName: string,
  files: { [key: string]: BuildFile },
  refs: any
): { [key: string]: BuildFile } {
  if (refs && typeof refs !== 'object') {
    throw new Error(`${fileName} references need to be an object`)
  }

  const result: { [key: string]: BuildFile } = {}
  for (const key of Object.keys(refs)) {
    const value = refs[key]
    const referenceFileName = join(dirname(fileName), value)
    if (!existsSync(referenceFileName)) {
      throw new Error(`${fileName} ${type} ${key} not found`)
    }
    result[key] = readBuildFile(referenceFileName, files)
  }
  return result
}
