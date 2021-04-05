import { parse } from 'yaml'
import { existsSync, readFileSync } from 'fs'
import { BuildFile } from './config'
import { ParsedBuildFileTask } from './parsedBuildFileTask'
import { ParsedDockerBuildFileTask } from './parsedDockerBuildFileTask'
import { ParsedBuildFileImpl } from './parsedBuildFileImpl'
import { BuildFileReference } from './buildFileReference'

export type ParsedTask = ParsedBuildFileTask | ParsedDockerBuildFileTask

export function parseBuildFile(fileName: string, parentBuildFile: BuildFileReference | null) {
  const buildFile = readBuildFile(fileName)
  return new ParsedBuildFileImpl(fileName, buildFile, parentBuildFile)
}

function readBuildFile(fileName: string): BuildFile {
  if (!existsSync(fileName)) {
    throw new Error(`${fileName} not found`)
  }

  let content: string
  try {
    content = readFileSync(fileName).toString()
  } catch (e) {
    throw new Error(`unable to read ${fileName}`)
  }

  let buildFile: BuildFile
  try {
    buildFile = parse(content)
  } catch (e) {
    throw new Error(`unable to parse yaml for ${fileName}`)
  }

  return buildFile
}
