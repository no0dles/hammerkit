import Dockerode, { VolumeInspectInfo } from 'dockerode'
import { StatusScopedConsole } from '../planner/work-item-status'
import { getErrorMessage } from '../log'

export async function existsVolume(docker: Dockerode, volumeName: string): Promise<VolumeInspectInfo | false> {
  try {
    const volume = await docker.getVolume(volumeName)
    return await volume.inspect()
  } catch (e) {
    return false
  }
}

export async function ensureVolumeExists(
  docker: Dockerode,
  scopedConsole: StatusScopedConsole,
  volumeName: string
): Promise<void> {
  const volumeExists = await existsVolume(docker, volumeName)
  if (!volumeExists) {
    await createVolume(docker, scopedConsole, volumeName)
  } else {
    scopedConsole.write('debug', 'volume exists ' + volumeName)
  }
}

export async function createVolume(
  docker: Dockerode,
  scopedConsole: StatusScopedConsole,
  volumeName: string
): Promise<void> {
  scopedConsole.write('debug', 'create volume ' + volumeName)
  await docker.createVolume({
    Name: volumeName,
    Driver: 'local',
    Labels: { app: 'hammerkit' },
  })
}

export async function removeVolume(
  docker: Dockerode,
  scopedConsole: StatusScopedConsole,
  volumeName: string
): Promise<boolean> {
  try {
    const volume = await docker.getVolume(volumeName)
    scopedConsole.write('debug', 'remove volume ' + volumeName)
    await volume.remove({ force: true })
    return true
  } catch (e) {
    scopedConsole.write('warn', `removing volume ${volumeName} failed: ${getErrorMessage(e)}`)
    return false
  }
}

export async function recreateVolume(
  docker: Dockerode,
  scopedConsole: StatusScopedConsole,
  volumeName: string
): Promise<void> {
  await removeVolume(docker, scopedConsole, volumeName)
  await createVolume(docker, scopedConsole, volumeName)
}
