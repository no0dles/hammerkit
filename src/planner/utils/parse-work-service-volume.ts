import { normalizePath } from './normalize-path'
import { WorkVolume } from '../work-volume'

export function parseWorkServiceVolume(cwd: string, dir: string): WorkVolume {
  const parts = dir.split(':')
  if (parts.length === 2) {
    return parseVolume(cwd, parts[0], parts[1])
  } else {
    throw new Error(`invalid volume ${dir}`)
  }
}

function parseVolume(cwd: string, name: string, containerPath: string): WorkVolume {
  return {
    name,
    resetOnChange: false,
    containerPath: normalizePath(cwd, cwd, containerPath),
    inherited: false,
  }
}
