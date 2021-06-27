import { join } from 'path'
import { WorkNodeMount } from '../work-node-mount'
import { homedir } from 'os'

export function parseWorkNodeMount(cwd: string, dir: string): WorkNodeMount {
  const parts = dir.split(':')
  if (parts.length === 1) {
    if (dir.startsWith('/')) {
      return { localPath: parseLocalMount(cwd, dir), containerPath: dir }
    } else {
      return { localPath: parseLocalMount(cwd, dir), containerPath: join(cwd, dir) }
    }
  } else if (parts.length === 2) {
    if (parts[1].startsWith('/')) {
      return { localPath: parseLocalMount(cwd, parts[0]), containerPath: parts[1] }
    } else {
      return { localPath: parseLocalMount(cwd, parts[0]), containerPath: join(cwd, parts[1]) }
    }
  } else {
    throw new Error(`invalid mount ${dir}`)
  }
}

function parseLocalMount(cwd: string, dir: string) {
  if (dir.startsWith('/')) {
    return dir
  } else if (dir.startsWith('$PWD')) {
    return join(homedir(), dir.substr('$PWD'.length))
  } else {
    return join(cwd, dir)
  }
}
