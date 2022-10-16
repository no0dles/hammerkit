import { BuildFile } from './build-file'
import { dirname } from 'path'
import { parseBuildFileReferences } from './parse-build-file-references'
import { parseEnvs } from './parse-envs'
import { readEnvFile } from './read-env-file'
import { parseStringArray } from './parse-string-array'
import { parseBuildFileTaskSource } from './parse-build-file-task-source'
import { parseBuildFileCommand } from './parse-build-file-task-command'
import { Environment } from '../executer/environment'
import { parseBuildFileServices } from './parse-build-file-services'
import { parseStringMap } from './parse-string-map'
import { ParseContext } from './parse-context'
import { parseString } from './parse-string'

const validTaskKeys = ['envs', 'src', 'needs', 'deps', 'generates', 'labels', 'description', 'extend', 'cmds', 'watch']
const validDockerTaskKeys = ['image', 'mounts', 'ports', 'shell', ...validTaskKeys]

export async function parseBuildFile(
  fileName: string,
  files: { [key: string]: BuildFile },
  input: unknown,
  context: Environment
): Promise<BuildFile> {
  const result: BuildFile = {
    fileName,
    includes: {},
    tasks: {},
    path: dirname(fileName),
    references: {},
    envs: {},
    services: {},
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
      result.envs = parseEnvs({ type: 'buildfile', fileName }, value || {}, result.envs)
    } else if (key === 'services') {
      result.services = parseBuildFileServices(fileName, value || {}, result)
    }
  }

  const tasks = 'tasks' in input ? (input as any)['tasks'] : null
  if (tasks && typeof tasks !== 'object') {
    throw new Error(`${fileName} tasks need to be an object`)
  }

  for (const key of Object.keys(tasks || {})) {
    const value = tasks[key]
    if (typeof value !== 'object') {
      throw new Error(`${fileName} task ${key} needs to be an object`)
    }

    const ctx: ParseContext = { fileName, name: key, type: 'task' }
    const validKeys = value.image ? validDockerTaskKeys : validTaskKeys
    result.tasks[key] = {
      envs: parseEnvs(ctx, value.envs || {}, {}),
      mounts: parseStringArray(ctx, 'mounts', value.mounts),
      src: parseBuildFileTaskSource(ctx, value.src, context),
      deps: parseStringArray(ctx, 'deps', value.deps),
      generates: parseStringArray(ctx, 'generates', value.generates),
      description: parseString(ctx, 'description', value.description, true)?.trim() ?? null,
      labels: parseStringMap(ctx, 'labels', value.labels),
      image: value.image || null,
      extend: value.extend || null,
      shell: value.shell || null,
      needs: value.needs || null,
      ports: parseStringArray(ctx, 'ports', value.ports),
      cmds: parseBuildFileCommand(ctx, value.cmds),
      unknownProps: Object.keys(value)
        .filter((k) => validKeys.indexOf(k) === -1)
        .reduce<{ [key: string]: any }>((map, k) => {
          map[k] = value[k]
          return map
        }, {}),
      platform: null,
      continuous: null,
      cache: value.caching || null,
    }
    if (Object.keys(result.tasks[key].unknownProps).length > 0) {
      context.console.warn(`unknown props ${Object.keys(result.tasks[key].unknownProps)} for ${key} in ${fileName}`)
    }
  }

  return result
}
