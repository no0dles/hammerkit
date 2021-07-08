import { dirname, join } from 'path'
import { readBuildFile } from './read-build-file'
import { BuildFile } from './build-file'
import { Context } from '../run-arg'

export async function parseBuildFileReferences(
  type: string,
  fileName: string,
  files: { [key: string]: BuildFile },
  refs: any,
  context: Context
): Promise<{ [key: string]: BuildFile }> {
  if (refs && typeof refs !== 'object') {
    throw new Error(`${fileName} references need to be an object`)
  }

  const result: { [key: string]: BuildFile } = {}
  for (const key of Object.keys(refs)) {
    const value = refs[key]
    const referenceFileName = join(dirname(fileName), value)
    if (!(await context.file.exists(referenceFileName))) {
      throw new Error(`${fileName} ${type} ${key} not found`)
    }
    result[key] = await readBuildFile(referenceFileName, files, context)
  }
  return result
}
