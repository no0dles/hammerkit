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
    const parts = volume.split(':')
    if (parts.length === 2) {
      return parseVolume(cwd, parts[0], parts[1])
    } else {
      throw new Error(`invalid volume ${volume}`)
    }
  } else {
    const path = templateValue(volume.path, envs)
    return {
      containerPath: path,
      export: volume.export ?? false,
      name: volume.name ? templateValue(volume.name, envs) : getVolumeName(path),
      inherited: false,
      resetOnChange: volume.resetOnChange ?? false,
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

function parseVolume(cwd: string, name: string, containerPath: string): WorkVolume {
  return {
    name,
    resetOnChange: false,
    containerPath: normalizePath(cwd, cwd, containerPath),
    inherited: false,
    export: false,
  }
}
