import { BuildFile } from './build-file'
import { dirname } from 'path'
import { parseBuildFileReferences } from './parse-build-file-references'
import { parseEnvs } from './parse-envs'
import { readEnvFile } from './read-env-file'
import { parseStringArray } from './parse-string-array'
import { parseBuildFileTaskSource } from './parse-build-file-task-source'
import { parseBuildFileCommand } from './parse-build-file-task-command'
import { Environment } from '../executer/environment'
import { BuildFileContainerRuntime } from './build-file-container-runtime'

const validTaskKeys = ['envs', 'src', 'deps', 'generates', 'description', 'extend', 'cmds', 'watch']
const validDockerTaskKeys = ['image', 'mounts', 'shell', ...validTaskKeys]

export async function parseBuildFile(
  fileName: string,
  files: { [key: string]: BuildFile },
  input: unknown,
  context: Environment
): Promise<BuildFile> {
  const result: BuildFile = {
    fileName,
    containerRuntime: {
      type: 'docker',
    },
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

  result.envs = await readEnvFile(dirname(fileName), result.envs, context)

  for (const [key, value] of Object.entries(input)) {
    if (key === 'includes') {
      result.includes = await parseBuildFileReferences('include', fileName, files, value || {}, context)
    } else if (key === 'references') {
      result.references = await parseBuildFileReferences('reference', fileName, files, value || {}, context)
    } else if (key === 'envs') {
      result.envs = parseEnvs(fileName, value || {}, result.envs)
    } else if (key === 'containerRuntime') {
      result.containerRuntime = parseContainerRuntime(value)
    }
  }

  const tasks = 'tasks' in input ? (input as any)['tasks'] : null
  if (tasks && typeof tasks !== 'object') {
    throw new Error(`${fileName} tasks need to be an object`)
  }

  for (const key of Object.keys(tasks)) {
    const value = tasks[key]
    if (typeof value !== 'object') {
      throw new Error(`${fileName} task ${key} needs to be an object`)
    }

    const validKeys = value.image ? validDockerTaskKeys : validTaskKeys
    result.tasks[key] = {
      envs: parseEnvs(fileName, value.envs || {}, {}),
      mounts: parseStringArray(fileName, key, 'mounts', value.mounts),
      src: parseBuildFileTaskSource(fileName, key, value.src, context),
      deps: parseStringArray(fileName, key, 'deps', value.deps),
      generates: parseStringArray(fileName, key, 'generates', value.generates),
      description: value.description ? value.description.trim() : null,
      image: value.image || null,
      extend: value.extend || null,
      shell: value.shell || null,
      ports: parseStringArray(fileName, key, 'ports', value.ports),
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

function parseContainerRuntime(value: any): BuildFileContainerRuntime {
  const runtime: BuildFileContainerRuntime = {
    type: 'docker',
  }

  const supportedRuntimes = ['docker', 'kubernetes']
  if (value.type && supportedRuntimes.indexOf(value.type) === -1) {
    throw new Error(`unsupported container runtime of type ${value.type}`)
  }
  runtime.type = value.type

  return runtime
}
