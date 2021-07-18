import { parse as yamlParse } from 'yaml'
import { BuildFile } from './build-file'
import { Environment } from '../run-arg'
import { parseBuildFile } from './parse-build-file'

export async function read(fileName: string, context: Environment): Promise<any> {
  // context.console.debug(`read ${fileName} build file`)
  let content: string
  try {
    content = await context.file.read(fileName)
  } catch (e) {
    throw new Error(`unable to read ${fileName}`)
  }
  try {
    return yamlParse(content)
  } catch (e) {
    throw new Error(`unable to parse ${fileName}: ${e.message}`)
  }
}

export async function readBuildFile(
  fileName: string,
  files: { [key: string]: BuildFile },
  context: Environment
): Promise<BuildFile> {
  if (files[fileName]) {
    return files[fileName]
  }

  const input = await read(fileName, context)
  return parseBuildFile(fileName, files, input, context)
}
