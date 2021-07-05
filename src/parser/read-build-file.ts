import { parse as yamlParse } from 'yaml'
import { dirname } from 'path'
import { parseBuildFileReferences } from './parse-build-file-references'
import { parseEnvs } from './parse-envs'
import { readEnvFile } from './read-env-file'
import { parseBuildFileTaskSource } from './parse-build-file-task-source'
import { parseBuildFileCommand } from './parse-build-file-task-command'
import { parseStringArray } from './parse-string-array'
import { BuildFile } from './build-file'
import {Context} from '../run-arg';

export async function read(fileName: string, context: Context): Promise<any> {
  context.console.debug(`read ${fileName} build file`)
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

const validTaskKeys = ['envs', 'src', 'deps', 'generates', 'description', 'extend', 'cmds', 'watch']
const validDockerTaskKeys = ['image', 'mounts', 'shell', ...validTaskKeys]

export async function readBuildFile(fileName: string, files: { [key: string]: BuildFile }, context: Context): Promise<BuildFile> {
  if (files[fileName]) {
    return files[fileName]
  }

  const input = await read(fileName, context)
  const result: BuildFile = {
    fileName,
    includes: {},
    tasks: {},
    path: dirname(fileName),
    references: {},
    envs: {},
  }
  files[fileName] = result

  result.includes = await parseBuildFileReferences('include', fileName, files, input.includes || {}, context)
  result.references = await parseBuildFileReferences('reference', fileName, files, input.references || {}, context)
  result.envs = parseEnvs(fileName, input.envs || {}) || {}
  result.envs = await readEnvFile(dirname(fileName), result.envs, context)

  if (input.tasks && typeof input.tasks !== 'object') {
    throw new Error(`${fileName} tasks need to be an object`)
  }

  for (const key of Object.keys(input.tasks || {})) {
    const value = input.tasks[key]
    const validKeys = value.image ? validDockerTaskKeys : validTaskKeys
    result.tasks[key] = {
      envs: parseEnvs(fileName, value.envs || {}),
      mounts: parseStringArray(fileName, key, 'mounts', value.mounts),
      src: parseBuildFileTaskSource(fileName, key, value, context),
      deps: parseStringArray(fileName, key, 'deps', value.deps),
      generates: parseStringArray(fileName, key, 'generates', value.generates),
      description: value.description ? value.description.trim() : null,
      image: value.image || null,
      extend: value.extend || null,
      shell: value.shell || null,
      cmds: parseBuildFileCommand(fileName, key, value.cmds),
      unknownProps: Object.keys(value)
        .filter((k) => validKeys.indexOf(k) === -1)
        .reduce<{ [key: string]: any }>((map, k) => {
          map[k] = value[k]
          return map
        }, {}),
      platform: null,
      continuous: null,
    }
    if (Object.keys(result.tasks[key].unknownProps).length > 0) {
      context.console.warn(`unknown props ${Object.keys(result.tasks[key].unknownProps)} for ${key} in ${fileName}`)
    }
  }

  return result
}
