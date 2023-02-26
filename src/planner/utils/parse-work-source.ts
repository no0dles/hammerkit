import { Minimatch } from 'minimatch'
import { join, relative } from 'path'
import { WorkSource } from '../work-source'
import { templateValue } from './template-value'
import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'

export function parseWorkSource(
  cwd: string,
  sources: string[] | null | undefined,
  envs: WorkEnvironmentVariables
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
            const matcher = new Minimatch(source, { dot: true })
            return matcher.match(relative(cwd, file))
          },
          inherited: false,
          source,
          absolutePath,
        })
      } else {
        const prefixSource = source.substr(0, wildcardIndex)
        const absolutePath = join(cwd, templateValue(prefixSource, envs))
        result.push({
          matcher: (file, cwd) => {
            const matcher = new Minimatch(join(cwd, source), { dot: true })
            return matcher.match(file)
          },
          inherited: false,
          source,
          absolutePath,
        })
      }
    } else {
      const absolutePath = join(cwd, templateValue(source, envs))
      result.push({
        matcher: (file) => file.startsWith(absolutePath),
        absolutePath,
        source,
        inherited: false,
      })
    }
  }

  return result
}

export function createSource(absolutePath: string): WorkSource {
  return {
    matcher: (file) => file.startsWith(absolutePath),
    absolutePath,
    source: absolutePath,
    inherited: false,
  }
}
