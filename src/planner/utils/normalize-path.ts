import { join } from 'path'

export function normalizePath(cwd: string, pwd: string, path: string) {
  if (path.startsWith('/')) {
    return path
  } else if (path.startsWith('$PWD')) {
    return join(pwd, path.substring('$PWD'.length))
  } else {
    return join(cwd, path)
  }
}

// What a path of the host starts with to name the home directory: `~` and `$HOME`, and
// `$PWD`, which in a mount has always meant the home directory, not the project it reads like
export function getHomeReference(path: string): '~' | '$HOME' | '$PWD' | null {
  for (const reference of ['~', '$HOME'] as const) {
    if (path === reference || path.startsWith(`${reference}/`) || path.startsWith(`${reference}\\`)) {
      return reference
    }
  }
  return path.startsWith('$PWD') ? '$PWD' : null
}

// A path of the host in a mount: in the home directory when it starts with one of the
// references above, else in the directory of the build file unless it is absolute
export function normalizeHostPath(cwd: string, home: string, path: string): string {
  const reference = getHomeReference(path)
  return reference ? join(home, path.substring(reference.length)) : normalizePath(cwd, home, path)
}
