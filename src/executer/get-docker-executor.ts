import { VolumeInspectInfo } from 'dockerode'
import { Environment } from './environment'

export async function existsVolume(environment: Environment, volumeName: string): Promise<VolumeInspectInfo | false> {
  try {
    const volume = await environment.docker.getVolume(volumeName)
    return await volume.inspect()
  } catch (e) {
    return false
  }
}

export async function ensureVolumeExists(environment: Environment, volumeName: string): Promise<void> {
  const volumeExists = await existsVolume(environment, volumeName)
  if (!volumeExists) {
    await createVolume(environment, volumeName)
  }
}

export async function createVolume(environment: Environment, volumeName: string): Promise<void> {
  await environment.docker.createVolume({
    Name: volumeName,
    Driver: 'local',
    Labels: { app: 'hammerkit' },
  })
}

export async function removeVolume(environment: Environment, volumeName: string): Promise<boolean> {
  try {
    const volume = await environment.docker.getVolume(volumeName)
    await volume.remove()
    return true
  } catch (e) {
    return false
  }
}

export async function recreateVolume(environment: Environment, volumeName: string): Promise<void> {
  await removeVolume(environment, volumeName)
  await createVolume(environment, volumeName)
}
