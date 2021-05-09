import { existsSync, readFileSync } from 'fs'
import { parse as yamlParse } from 'yaml'
import { dirname, join } from 'path'
import { Minimatch } from 'minimatch'
import consola from 'consola'

export interface ExecutionBuildFile {
  fileName: string
  path: string
  envs: { [key: string]: string }
  tasks: { [key: string]: ExecutionBuildTask }
  references: { [key: string]: ExecutionBuildFile }
  includes: { [key: string]: ExecutionBuildFile }
}

export type ExecutionBuildTaskCmd = string | { type: 'cmd'; cmd: string; path?: string }

export interface ExecutionBuildSource {
  relativePath: string
  matcher: (fileName: string, cwd: string) => boolean
}

export interface ExecutionBuildTask {
  deps: string[] | null
  src: ExecutionBuildSource[] | null
  description: string | null
  shell: string | null
  generates: string[] | null
  extend: string | null
  image: string | null
  mounts: string[] | null
  cmds: ExecutionBuildTaskCmd[] | null
  envs: { [key: string]: string } | null
  unknownProps: { [key: string]: any }
}

export function read(fileName: string): any {
  consola.debug(`read ${fileName} build file`)
  let content: string
  try {
    content = readFileSync(fileName).toString()
  } catch (e) {
    throw new Error(`unable to read ${fileName}`)
  }
  try {
    return yamlParse(content)
  } catch (e) {
    throw new Error(`unable to parse ${fileName}: ${e.message}`)
  }
}

export function parse(fileName: string): ExecutionBuildFile {
  return readFile(fileName, {})
}

function loadEnvFile(path: string, baseEnv: { [key: string]: string }): { [key: string]: string } {
  const directory = join(path, '.env')
  if (!existsSync(directory)) {
    return baseEnv
  }

  const envs = { ...baseEnv }
  const envFile = readFileSync(directory).toString().split(/\r?\n/)
  for (const envVar of envFile) {
    const index = envVar.indexOf('=')
    if (index > 0) {
      const key = envVar.substr(0, index)
      const value = envVar.substr(index + 1)
      if (!envs[key]) {
        consola.debug(`load env variable ${key} from ${directory} file`)
        envs[key] = value
      }
    }
  }

  return envs
}

const validTaskKeys = ['envs', 'src', 'deps', 'generates', 'description', 'extend', 'cmds']
const validDockerTaskKeys = ['image', 'mounts', 'shell', ...validTaskKeys]

function readFile(fileName: string, files: { [key: string]: ExecutionBuildFile }): ExecutionBuildFile {
  if (files[fileName]) {
    return files[fileName]
  }

  const input = read(fileName)
  const result: ExecutionBuildFile = {
    fileName,
    includes: {},
    tasks: {},
    path: dirname(fileName),
    references: {},
    envs: {},
  }
  files[fileName] = result

  result.includes = parseReferences('include', fileName, files, input.includes || {})
  result.references = parseReferences('reference', fileName, files, input.references || {})
  result.envs = parseEnvs(fileName, input.envs || {}) || {}
  result.envs = loadEnvFile(dirname(fileName), result.envs)

  if (input.tasks && typeof input.tasks !== 'object') {
    throw new Error(`${fileName} tasks need to be an object`)
  }

  for (const key of Object.keys(input.tasks || {})) {
    const value = input.tasks[key]
    const validKeys = value.image ? validDockerTaskKeys : validTaskKeys
    result.tasks[key] = {
      envs: parseEnvs(fileName, value.envs || {}),
      mounts: parseStringArray(fileName, key, 'mounts', value.mounts),
      src: parseSources(fileName, key, value),
      deps: parseStringArray(fileName, key, 'deps', value.deps),
      generates: parseStringArray(fileName, key, 'generates', value.generates),
      description: value.description ? value.description.trim() : null,
      image: value.image || null,
      extend: value.extend || null,
      shell: value.shell || null,
      cmds: parseCommands(fileName, key, value.cmds),
      unknownProps: Object.keys(value)
        .filter((k) => validKeys.indexOf(k) === -1)
        .reduce<{ [key: string]: any }>((map, k) => {
          map[k] = value[k]
          return map
        }, {}),
    }
    if (Object.keys(result.tasks[key].unknownProps).length > 0) {
      consola.warn(`unknown props ${Object.keys(result.tasks[key].unknownProps)} for ${key} in ${fileName}`)
    }
  }

  return result
}

function parseSources(fileName: string, key: string, value: any): ExecutionBuildSource[] | null {
  const sources = parseStringArray(fileName, key, 'src', value.src)
  if (!sources) {
    return null
  }

  const result: ExecutionBuildSource[] = []

  for (const source of sources) {
    const wildcardIndex = source.indexOf('*')
    if (wildcardIndex >= 0) {
      if (wildcardIndex === 0) {
        result.push({
          matcher: (file, cwd) => {
            const matcher = new Minimatch(join(cwd, source), { dot: true })
            const match = matcher.match(file)
            if (match) {
              consola.debug(`file ${file} matches source ${source}`)
            } else {
              consola.debug(`file ${file} does not matche source ${source}`)
            }
            return match
          },
          relativePath: '.',
        })
      } else {
        const prefixSource = source.substr(0, wildcardIndex)
        result.push({
          matcher: (file, cwd) => {
            const matcher = new Minimatch(join(cwd, source), { dot: true })
            const match = matcher.match(file)
            if (match) {
              consola.debug(`file ${file} matches source ${source}`)
            } else {
              consola.debug(`file ${file} does not matche source ${source}`)
            }
            return match
          },
          relativePath: prefixSource,
        })
      }
    } else {
      result.push({
        matcher: (file, cwd) => file.startsWith(join(cwd, source)),
        relativePath: source,
      })
    }
  }

  return result
}

function parseCommands(fileName: string, taskName: string, value: any): ExecutionBuildTaskCmd[] | null {
  if (!value) {
    return null
  }

  if (!(value instanceof Array)) {
    throw new Error(`${fileName} task ${taskName} cmds needs to be an array`)
  }

  return value.map<ExecutionBuildTaskCmd>((cmd) => {
    if (typeof cmd === 'string') {
      return cmd.trim()
    } else if (typeof cmd === 'object' && !!cmd.cmd) {
      if (!(typeof cmd.cmd === 'string')) {
        throw new Error(`${fileName} task ${taskName} cmd needs to be a string`)
      }

      if (cmd.path) {
        if (!(typeof cmd.path === 'string')) {
          throw new Error(`${fileName} task ${taskName} cmd path needs to be a string`)
        }
        return { cmd: cmd.cmd.trim(), path: cmd.path, type: 'cmd' }
      } else {
        return { cmd: cmd.cmd.trim(), type: 'cmd' }
      }
    } else {
      throw new Error(`${fileName} task ${taskName} unknown cmd`)
    }
  })
}

function parseStringArray(fileName: string, taskName: string, valueName: string, value: any): string[] | null {
  if (!value) {
    return null
  }
  if (value instanceof Array) {
    if (!value.every((v) => typeof v === 'string')) {
      throw new Error(`${fileName} task ${taskName} ${valueName} needs to be a string array`)
    }
    return value
  } else {
    throw new Error(`${fileName} task ${taskName} ${valueName} needs to be a string array`)
  }
}

function parseReferences(
  type: string,
  fileName: string,
  files: { [key: string]: ExecutionBuildFile },
  refs: any
): { [key: string]: ExecutionBuildFile } {
  if (refs && typeof refs !== 'object') {
    throw new Error(`${fileName} references need to be an object`)
  }

  const result: { [key: string]: ExecutionBuildFile } = {}
  for (const key of Object.keys(refs)) {
    const value = refs[key]
    const referenceFileName = join(dirname(fileName), value)
    if (!existsSync(referenceFileName)) {
      throw new Error(`${fileName} ${type} ${key} not found`)
    }
    result[key] = readFile(referenceFileName, files)
  }
  return result
}

function parseEnvs(fileName: string, envs: any): { [key: string]: string } | null {
  if (envs && typeof envs !== 'object') {
    throw new Error(`${fileName} envs need to be an object`)
  }

  if (!envs) {
    return null
  }

  const result: { [key: string]: string } = {}
  for (const key of Object.keys(envs || {})) {
    const value = envs[key]
    if (typeof value === 'string') {
      result[key] = value
    } else if (typeof value === 'number') {
      result[key] = value.toString()
    } else {
      throw new Error(`${fileName} envs ${key} need to be a string or number`)
    }
  }

  return result
}
