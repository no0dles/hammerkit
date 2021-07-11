import { Minimatch } from 'minimatch'
import { join } from 'path'
import { parseStringArray } from './parse-string-array'
import { BuildFileTaskSource } from './build-file-task-source'
import { Context } from '../run-arg'

export function parseBuildFileTaskSource(
  fileName: string,
  taskName: string,
  value: unknown,
  context: Context
): BuildFileTaskSource[] | null {
  if (!value) {
    return null
  }

  if (typeof value !== 'string') {
    throw new Error(`${fileName} task ${taskName} source needs to be of type string`)
  }

  const sources = parseStringArray(fileName, taskName, 'src', value)
  if (!sources) {
    return null
  }

  const result: BuildFileTaskSource[] = []

  for (const source of sources) {
    const wildcardIndex = source.indexOf('*')
    if (wildcardIndex >= 0) {
      if (wildcardIndex === 0) {
        result.push({
          matcher: (file, cwd) => {
            const matcher = new Minimatch(join(cwd, source), { dot: true })
            const match = matcher.match(file)
            if (match) {
              context.console.debug(`file ${file} matches source ${source}`)
            } else {
              context.console.debug(`file ${file} does not matche source ${source}`)
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
              context.console.debug(`file ${file} matches source ${source}`)
            } else {
              context.console.debug(`file ${file} does not matche source ${source}`)
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
