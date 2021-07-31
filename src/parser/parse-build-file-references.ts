import { dirname, join } from 'path'
import { readBuildFile } from './read-build-file'
import { BuildFile } from './build-file'
import { Environment } from '../executer/environment'

export async function parseBuildFileReferences(
  type: string,
  fileName: string,
  files: { [key: string]: BuildFile },
  refs: unknown,
  context: Environment
): Promise<{ [key: string]: BuildFile }> {
  if (!refs) {
    return {}
  }

  if (typeof refs !== 'object') {
    throw new Error(`${fileName} references need to be an object`)
  }

  const result: { [key: string]: BuildFile } = {}
  for (const [key, value] of Object.entries(refs || {})) {
    const referenceFileName = join(dirname(fileName), value)
    if (!(await context.file.exists(referenceFileName))) {
      throw new Error(`${fileName} ${type} ${key} not found`)
    }
    result[key] = await readBuildFile(referenceFileName, files, context)
  }
  return result
}
