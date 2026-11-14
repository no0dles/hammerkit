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

// The label a volume gets when a server run made it for outputs in its files (a sandbox's),
// so the server finds it again to measure it and to remove it with the sandbox.
export const VOLUME_ROOT_LABEL = 'hammerkit-root'

export function volumeLabels(root: string | undefined): { [key: string]: string } {
  return root ? { [VOLUME_ROOT_LABEL]: root } : {}
}

export async function ensureVolumeExists(
  docker: Dockerode,
  scopedConsole: StatusScopedConsole,
  volumeName: string,
  labels: { [key: string]: string } = {}
): Promise<void> {
  const volumeExists = await existsVolume(docker, volumeName)
  if (!volumeExists) {
    await createVolume(docker, scopedConsole, volumeName, labels)
  } else {
    scopedConsole.write('debug', 'volume exists ' + volumeName)
  }
}

export async function createVolume(
  docker: Dockerode,
  scopedConsole: StatusScopedConsole,
  volumeName: string,
  labels: { [key: string]: string } = {}
): Promise<void> {
  scopedConsole.write('debug', 'create volume ' + volumeName)
  await docker.createVolume({
    Name: volumeName,
    Driver: 'local',
    Labels: { ...labels, app: 'hammerkit' },
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
  volumeName: string,
  labels: { [key: string]: string } = {}
): Promise<void> {
  await removeVolume(docker, scopedConsole, volumeName)
  await createVolume(docker, scopedConsole, volumeName, labels)
}
