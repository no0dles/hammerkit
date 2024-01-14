import { homedir } from 'os'
import { normalizePath } from './normalize-path'
import { WorkMount } from '../work-mount'
import { extname } from 'path'

export function parseWorkMount(cwd: string, dir: string): WorkMount {
  const parts = dir.split(':')
  if (parts.length === 1) {
    return parseLocalMount(cwd, dir, dir, dir)
  } else if (parts.length === 2) {
    return parseLocalMount(cwd, parts[0], parts[1], dir)
  } else {
    throw new Error(`invalid mount ${dir}`)
  }
}

function parseLocalMount(cwd: string, localPath: string, containerPath: string, mount: string): WorkMount {
  return {
    localPath: normalizePath(cwd, homedir(), localPath),
    containerPath: normalizePath(cwd, cwd, containerPath),
    isFile: extname(localPath).length > 1,
    mount,
  }
}
