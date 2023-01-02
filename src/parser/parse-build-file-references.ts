import { dirname, join } from 'path'
import { readBuildFile } from './read-build-file'
import { BuildFile } from './build-file'
import { Environment } from '../executer/environment'
import { getDefaultBuildFilename } from './default-build-file'

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
      throw new Error(`${fileName} ${type} ${key} ${referenceFileName} not found`)
    }
    const stats = await context.file.stats(referenceFileName)
    if (stats.type === 'directory') {
      const defaultReferenceFileName = join(
        referenceFileName,
        await getDefaultBuildFilename(referenceFileName, context)
      )
      if (!(await context.file.exists(defaultReferenceFileName))) {
        throw new Error(`${fileName} ${type} ${key} ${defaultReferenceFileName} not found in ${referenceFileName}`)
      }
      result[key] = await readBuildFile(defaultReferenceFileName, files, context)
    } else {
      result[key] = await readBuildFile(referenceFileName, files, context)
    }
  }
  return result
}
