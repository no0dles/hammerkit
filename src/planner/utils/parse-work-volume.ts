import { normalizePath } from './normalize-path'
import { WorkVolume } from '../work-volume'
import { BuildFileVolumeSchema } from '../../schema/build-file-volume-schema'
import { getVolumeName } from './plan-work-volume'

export function parseWorkVolume(cwd: string, volume: BuildFileVolumeSchema): WorkVolume {
  if (typeof volume === 'string') {
    const parts = volume.split(':')
    if (parts.length === 2) {
      return parseVolume(cwd, parts[0], parts[1])
    } else {
      throw new Error(`invalid volume ${volume}`)
    }
  } else {
    return {
      containerPath: volume.path,
      export: volume.export ?? false,
      name: volume.name ?? getVolumeName(volume.path),
      inherited: false,
      resetOnChange: volume.resetOnChange ?? false,
    }
  }
}

export function parseWorkVolumes(cwd: string, volumes: BuildFileVolumeSchema[] | null | undefined): WorkVolume[] {
  if (!volumes) {
    return []
  }
  return volumes.map((v) => parseWorkVolume(cwd, v))
}

function parseVolume(cwd: string, name: string, containerPath: string): WorkVolume {
  return {
    name,
    resetOnChange: false,
    containerPath: normalizePath(cwd, cwd, containerPath),
    inherited: false,
    export: false,
  }
}
