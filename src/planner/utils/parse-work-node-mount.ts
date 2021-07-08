import { join } from 'path'
import { WorkNodePath } from '../work-node-path'
import { homedir } from 'os'

export function parseWorkNodeMount(cwd: string, dir: string): WorkNodePath {
  const parts = dir.split(':')
  if (parts.length === 1) {
    return parseLocalMount(cwd, dir, dir)
  } else if (parts.length === 2) {
    return parseLocalMount(cwd, parts[0], parts[1])
  } else {
    throw new Error(`invalid mount ${dir}`)
  }
}

function normalizePath(cwd: string, pwd: string, path: string) {
  if (path.startsWith('/')) {
    return path
  } else if (path.startsWith('$PWD')) {
    return join(pwd, path.substr('$PWD'.length))
  } else {
    return join(cwd, path)
  }
}

function parseLocalMount(cwd: string, localPath: string, containerPath: string): WorkNodePath {
  return {
    localPath: normalizePath(cwd, homedir(), localPath),
    containerPath: normalizePath(cwd, cwd, containerPath),
  }
}
