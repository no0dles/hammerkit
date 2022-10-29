import { join } from 'path'

export function normalizePath(cwd: string, pwd: string, path: string) {
  if (path.startsWith('/')) {
    return path
  } else if (path.startsWith('$PWD')) {
    return join(pwd, path.substr('$PWD'.length))
  } else {
    return join(cwd, path)
  }
}
