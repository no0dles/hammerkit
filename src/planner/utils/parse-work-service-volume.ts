import { WorkServiceVolume } from '../work-service-volume'
import { normalizePath } from './normalize-path'

export function parseWorkServiceVolume(cwd: string, dir: string): WorkServiceVolume {
  const parts = dir.split(':')
  if (parts.length === 2) {
    return parseVolume(cwd, parts[0], parts[1])
  } else {
    throw new Error(`invalid volume ${dir}`)
  }
}

function parseVolume(cwd: string, name: string, containerPath: string): WorkServiceVolume {
  return {
    name,
    containerPath: normalizePath(cwd, cwd, containerPath),
  }
}
