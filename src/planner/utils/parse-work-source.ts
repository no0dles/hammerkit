import { Minimatch } from 'minimatch'
import { extname, join, posix, relative, sep } from 'path'
import { WorkSource } from '../work-source'
import { templateValue } from './template-value'
import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'

// minimatch globs are always '/'-separated; on Windows path.join/relative yield
// '\\', which minimatch treats as escape chars (so a native pattern never
// matches). Normalize both the pattern and the candidate to posix before
// matching. No-op on posix, where sep === posix.sep.
const toPosix = (value: string): string => (sep === posix.sep ? value : value.split(sep).join(posix.sep))

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
            return matcher.match(toPosix(relative(cwd, file)))
          },
          inherited: null,
          source,
          absolutePath,
          isFile: false,
        })
      } else {
        const prefixSource = source.substring(0, wildcardIndex)
        const absolutePath = join(cwd, templateValue(prefixSource, envs))
        result.push({
          matcher: (file, cwd) => {
            const matcher = new Minimatch(toPosix(join(cwd, source)), { dot: true })
            return matcher.match(toPosix(file))
          },
          inherited: null,
          source,
          absolutePath,
          isFile: false,
        })
      }
    } else {
      const absolutePath = join(cwd, templateValue(source, envs))
      result.push({
        matcher: (file) => file.startsWith(absolutePath),
        absolutePath,
        source,
        inherited: null,
        isFile: extname(absolutePath).length > 1,
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
    inherited: null,
    isFile: extname(absolutePath).length > 1,
  }
}
