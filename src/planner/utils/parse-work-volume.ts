import { normalizePath } from './normalize-path'
import { WorkVolume } from '../work-volume'
import { BuildFileVolumeSchema } from '../../schema/build-file-volume-schema'
import { getVolumeName } from './plan-work-volume'
import { templateValue } from './template-value'
import { WorkEnvironmentVariables } from '../../environment/replace-env-variables'

export function parseWorkVolume(
  cwd: string,
  volume: BuildFileVolumeSchema,
  envs: WorkEnvironmentVariables
): WorkVolume {
  if (typeof volume === 'string') {
    // `$NAME` references resolve first, as in mounts, so a value holding a
    // colon can't break the name:path split
    const value = templateValue(volume, envs)
    const parts = value.split(':')
    if (parts.length === 2) {
      return parseVolume(cwd, parts[0], parts[1], false)
    } else if (parts.length === 3 && (parts[2] === 'ro' || parts[2] === 'rw')) {
      return parseVolume(cwd, parts[0], parts[1], parts[2] === 'ro')
    } else {
      throw new Error(`invalid volume ${value}`)
    }
  } else {
    const path = templateValue(volume.path, envs)
    return {
      containerPath: path,
      export: !!volume.export,
      name: volume.name ? templateValue(volume.name, envs) : getVolumeName(path),
      inherited: null,
      resetOnChange: volume.resetOnChange ?? false,
      readOnly: volume.readOnly ?? false,
    }
  }
}

export function parseWorkVolumes(
  cwd: string,
  volumes: BuildFileVolumeSchema[] | null | undefined,
  envs: WorkEnvironmentVariables
): WorkVolume[] {
  if (!volumes) {
    return []
  }
  return volumes.map((v) => parseWorkVolume(cwd, v, envs))
}

function parseVolume(cwd: string, name: string, containerPath: string, readOnly: boolean): WorkVolume {
  return {
    name,
    resetOnChange: false,
    containerPath: normalizePath(cwd, cwd, containerPath),
    inherited: null,
    export: false,
    readOnly,
  }
}
