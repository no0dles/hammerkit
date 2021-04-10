import { parse } from 'yaml'
import { existsSync, readFileSync } from 'fs'
import { BuildFile } from '../build-file'
import { BuildFileConfig } from '../config/build-file-config'
import { BuildFileReference } from '../build-file-reference'

export function parseBuildFile(fileName: string, parentBuildFile: BuildFileReference | null): BuildFile {
  const buildFile = readBuildFile(fileName)
  return new BuildFile(fileName, buildFile, parentBuildFile)
}

function readBuildFile(fileName: string): BuildFileConfig {
  if (!existsSync(fileName)) {
    throw new Error(`${fileName} not found`)
  }

  let content: string
  try {
    content = readFileSync(fileName).toString()
  } catch (e) {
    throw new Error(`unable to read ${fileName}`)
  }

  let buildFile: BuildFileConfig
  try {
    buildFile = parse(content)
  } catch (e) {
    throw new Error(`unable to parse yaml for ${fileName}`)
  }

  return buildFile
}
