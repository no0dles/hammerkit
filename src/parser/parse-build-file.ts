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
import { ParseContext, parseContextDescription } from './parse-context'
import { parseString } from './parse-string'
import { parseBoolean } from './parse-boolean'
import { BuildFileTaskGenerate } from './build-file-task'
import { parseNeedArray } from './parse-need-array'

const validTaskKeys = [
  'envs',
  'src',
  'needs',
  'deps',
  'generates',
  'labels',
  'description',
  'extend',
  'cmds',
  'continuous',
  'cache',
]
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
      generates: parseGenerateArray(ctx, 'generates', value.generates),
      description: parseString(ctx, 'description', value.description, true)?.trim() ?? null,
      labels: parseStringMap(ctx, 'labels', value.labels),
      image: value.image || null,
      extend: value.extend || null,
      shell: value.shell || null,
      needs: parseNeedArray(ctx, 'needs', value.needs),
      continuous: parseBoolean(ctx, 'continuous', value.continuous, true),
      ports: parseStringArray(ctx, 'ports', value.ports),
      cmds: parseBuildFileCommand(ctx, value.cmds),
      unknownProps: Object.keys(value)
        .filter((k) => validKeys.indexOf(k) === -1)
        .reduce<{ [key: string]: any }>((map, k) => {
          map[k] = value[k]
          return map
        }, {}),
      platform: null,
      cache: value.cache || null,
    }
    if (Object.keys(result.tasks[key].unknownProps).length > 0) {
      context.console.warn(`unknown props ${Object.keys(result.tasks[key].unknownProps)} for ${key} in ${fileName}`)
    }
  }

  return result
}

function parseGenerateArray(
  ctx: ParseContext,
  valueName: string,
  value: unknown
): (BuildFileTaskGenerate | string)[] | null {
  if (!value) {
    return null
  }
  if (value instanceof Array) {
    return value.map<BuildFileTaskGenerate | string>((v, i) => {
      if (typeof v === 'string') {
        return v
      } else {
        return {
          path: parseString(ctx, `generate[${i}].path`, v.path, false),
          resetOnChange: parseBoolean(ctx, `generate[${i}].resetOnChange`, v.resetOnChange, true) ?? false,
          export: parseBoolean(ctx, `generate[${i}].export`, v.export, true) ?? false,
        }
      }
    })
  } else {
    throw new Error(`${parseContextDescription(ctx)} ${valueName} needs to be a string array`)
  }
}
