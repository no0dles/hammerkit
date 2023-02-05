import { Minimatch } from 'minimatch'
import { join } from 'path'
import { WorkSource } from '../work-source'
import { templateValue } from './template-value'

export function parseWorkSource(
  cwd: string,
  sources: string[] | null | undefined,
  envs: { [key: string]: string } | null
): WorkSource[] {
  const result: WorkSource[] = []

  if (!sources) {
    return result
  }

  for (const source of sources) {
    const wildcardIndex = source.indexOf('*')
    if (wildcardIndex >= 0) {
      if (wildcardIndex === 0) {
        const absolutePath = cwd
        result.push({
          matcher: (file, cwd) => {
            const matcher = new Minimatch(absolutePath, { dot: true })
            const match = matcher.match(file)
            if (match) {
              // TODO environment.console.debug(`file ${file} matches source ${source}`)
            } else {
              // TODO environment.console.debug(`file ${file} does not matche source ${source}`)
            }
            return match
          },
          source,
          absolutePath,
        })
      } else {
        const prefixSource = source.substr(0, wildcardIndex)
        const absolutePath = join(cwd, templateValue(prefixSource, envs))
        result.push({
          matcher: (file, cwd) => {
            const matcher = new Minimatch(join(cwd, source), { dot: true })
            const match = matcher.match(file)
            if (match) {
              // TODO environment.console.debug(`file ${file} matches source ${source}`)
            } else {
              // TODO environment.console.debug(`file ${file} does not matche source ${source}`)
            }
            return match
          },
          source,
          absolutePath,
        })
      }
    } else {
      const absolutePath = join(cwd, templateValue(source, envs))
      result.push({
        matcher: (file, cwd) => file.startsWith(absolutePath),
        absolutePath,
        source,
      })
    }
  }

  return result
}
