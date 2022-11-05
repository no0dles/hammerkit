import { homedir } from 'os'
import { normalizePath } from './normalize-path'
import { WorkMount } from '../work-mount'

export function parseWorkNodeMount(cwd: string, dir: string): WorkMount {
  const parts = dir.split(':')
  if (parts.length === 1) {
    return parseLocalMount(cwd, dir, dir)
  } else if (parts.length === 2) {
    return parseLocalMount(cwd, parts[0], parts[1])
  } else {
    throw new Error(`invalid mount ${dir}`)
  }
}

function parseLocalMount(cwd: string, localPath: string, containerPath: string): WorkMount {
  return {
    localPath: normalizePath(cwd, homedir(), localPath),
    containerPath: normalizePath(cwd, cwd, containerPath),
  }
}
