import Dockerode, { VolumeInspectInfo } from 'dockerode'

export async function existsVolume(docker: Dockerode, volumeName: string): Promise<VolumeInspectInfo | false> {
  try {
    const volume = await docker.getVolume(volumeName)
    return await volume.inspect()
  } catch (e) {
    return false
  }
}

export async function ensureVolumeExists(docker: Dockerode, volumeName: string): Promise<void> {
  const volumeExists = await existsVolume(docker, volumeName)
  if (!volumeExists) {
    await docker.createVolume({
      Name: volumeName,
      Driver: 'local',
      Labels: { app: 'hammerkit' },
    })
  }
}
