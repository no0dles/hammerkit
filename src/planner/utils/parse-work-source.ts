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
    // env variables are substituted before matching, so `$DIR/*.ts` globs the
    // directory the task actually reads; `source` keeps the declared form.
    const pattern = posix.normalize(toPosix(templateValue(source, envs)))
    const matcher = new Minimatch(pattern, { dot: true })
    if (isGlob(matcher)) {
      // Walk from the literal directory prefix and match paths relative to the
      // declaring task's cwd — which stays correct when the source is inherited
      // by a dependant in another directory.
      const prefix = literalPrefix(pattern)
      result.push({
        matcher: (file, _cwd, partial) => matcher.match(toPosix(relative(cwd, file)), partial),
        inherited: null,
        source,
        absolutePath: prefix ? join(cwd, prefix) : cwd,
        isFile: false,
      })
    } else {
      const absolutePath = join(cwd, pattern)
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

// minimatch parses a literal path into a single set of plain strings; anything
// else (wildcards, ?, [...], {a,b}, extglobs) is a glob.
function isGlob(matcher: Minimatch): boolean {
  return matcher.set.length !== 1 || matcher.set[0].some((part) => typeof part !== 'string')
}

// The leading directories of a glob that contain no glob syntax — where the
// walk for matching files starts.
function literalPrefix(pattern: string): string {
  const segments = pattern.split('/')
  const literal: string[] = []
  for (const segment of segments.slice(0, -1)) {
    if (/[*?[\]{}()!+@]/.test(segment)) {
      break
    }
    literal.push(segment)
  }
  return literal.join('/')
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
