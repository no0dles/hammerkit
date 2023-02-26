import { VolumeInspectInfo } from 'dockerode'
import { Environment } from './environment'
import { StatusScopedConsole } from '../planner/work-item-status'
import { getErrorMessage } from '../log'

export async function existsVolume(environment: Environment, volumeName: string): Promise<VolumeInspectInfo | false> {
  try {
    const volume = await environment.docker.getVolume(volumeName)
    return await volume.inspect()
  } catch (e) {
    return false
  }
}

export async function ensureVolumeExists(
  environment: Environment,
  scopedConsole: StatusScopedConsole,
  volumeName: string
): Promise<void> {
  const volumeExists = await existsVolume(environment, volumeName)
  if (!volumeExists) {
    await createVolume(environment, scopedConsole, volumeName)
  } else {
    scopedConsole.write('debug', 'volume exists ' + volumeName)
  }
}

export async function createVolume(
  environment: Environment,
  scopedConsole: StatusScopedConsole,
  volumeName: string
): Promise<void> {
  scopedConsole.write('debug', 'create volume ' + volumeName)
  await environment.docker.createVolume({
    Name: volumeName,
    Driver: 'local',
    Labels: { app: 'hammerkit' },
  })
}

export async function removeVolume(
  environment: Environment,
  scopedConsole: StatusScopedConsole,
  volumeName: string
): Promise<boolean> {
  try {
    const volume = await environment.docker.getVolume(volumeName)
    scopedConsole.write('debug', 'remove volume ' + volumeName)
    await volume.remove({ force: true })
    return true
  } catch (e) {
    scopedConsole.write('warn', `removing volume ${volumeName} failed: ${getErrorMessage(e)}`)
    return false
  }
}

export async function recreateVolume(
  environment: Environment,
  scopedConsole: StatusScopedConsole,
  volumeName: string
): Promise<void> {
  await removeVolume(environment, scopedConsole, volumeName)
  await createVolume(environment, scopedConsole, volumeName)
}
