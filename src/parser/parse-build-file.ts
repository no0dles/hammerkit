import { BuildFile } from './build-file'
import { Environment } from '../run-arg'
import { dirname } from 'path'
import { parseBuildFileReferences } from './parse-build-file-references'
import { parseEnvs } from './parse-envs'
import { readEnvFile } from './read-env-file'
import { parseStringArray } from './parse-string-array'
import { parseBuildFileTaskSource } from './parse-build-file-task-source'
import { parseBuildFileCommand } from './parse-build-file-task-command'

const validTaskKeys = ['envs', 'src', 'deps', 'generates', 'description', 'extend', 'cmds', 'watch']
const validDockerTaskKeys = ['image', 'mounts', 'shell', ...validTaskKeys]

export async function parseBuildFile(
  fileName: string,
  files: { [key: string]: BuildFile },
  input: any,
  context: Environment
): Promise<BuildFile> {
  const result: BuildFile = {
    fileName,
    includes: {},
    tasks: {},
    path: dirname(fileName),
    references: {},
    envs: {},
  }
  files[fileName] = result

  if (typeof input !== 'object') {
    throw new Error(`${fileName} build file needs to be an object`)
  }

  if (!input) {
    return result
  }

  result.includes = await parseBuildFileReferences('include', fileName, files, input.includes || {}, context)
  result.references = await parseBuildFileReferences('reference', fileName, files, input.references || {}, context)
  result.envs = parseEnvs(fileName, input.envs || {}) || {}
  result.envs = await readEnvFile(dirname(fileName), result.envs, context)

  if (input.tasks && typeof input.tasks !== 'object') {
    throw new Error(`${fileName} tasks need to be an object`)
  }

  for (const key of Object.keys(input.tasks || {})) {
    const value = input.tasks[key]
    if (typeof value !== 'object') {
      throw new Error(`${fileName} task ${key} needs to be an object`)
    }

    const validKeys = value.image ? validDockerTaskKeys : validTaskKeys
    result.tasks[key] = {
      envs: parseEnvs(fileName, value.envs || {}),
      mounts: parseStringArray(fileName, key, 'mounts', value.mounts),
      src: parseBuildFileTaskSource(fileName, key, value.src, context),
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
