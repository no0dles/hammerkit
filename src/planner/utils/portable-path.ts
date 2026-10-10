import { homedir } from 'os'
import { isAbsolute, posix, relative, sep } from 'path'

const toPosix = (value: string): string => (sep === posix.sep ? value : value.split(sep).join(posix.sep))

function within(base: string, path: string): string | null {
  const rel = relative(base, path)
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return null
  }
  return toPosix(rel)
}

// Express an absolute path in a machine-independent form for cache identity:
// relative to the project root when inside it, relative to the home directory
// (`~/…`) when inside that, and unchanged otherwise (a fixed system path such as
// `/var/run/docker.sock` is already the same on every machine).
export function portablePath(projectRoot: string, path: string): string {
  const inRoot = within(projectRoot, path)
  if (inRoot !== null) {
    return inRoot.length > 0 ? inRoot : '.'
  }
  const inHome = within(homedir(), path)
  if (inHome !== null) {
    return inHome.length > 0 ? `~/${inHome}` : '~'
  }
  return toPosix(path)
}
