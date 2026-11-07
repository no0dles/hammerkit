import Dockerode from 'dockerode'
import { createDockerClient } from '../executer/execute-docker'
import { VOLUME_ROOT_LABEL } from '../executer/get-docker-executor'
import { isImagePresent } from '../docker/pull'

// what gives a sandbox back to the server's user: a shell with chown and chmod
const HELPER_IMAGE = 'alpine:3.21'

/**
 * What the containers of runs leave of a sandbox outside of what the server's user can
 * read and remove by itself: files a container wrote as another user (a service runs as
 * the user of its image), and the docker volumes of outputs.
 */
export interface SandboxContainers {
  // makes everything below the directory the server's user's again, readable and writable
  reclaim(directory: string): Promise<void>
  // the bytes of the volumes runs made for outputs in the directory
  volumeBytes(directory: string): Promise<number>
  removeVolumes(directory: string): Promise<void>
}

export class DockerSandboxContainers implements SandboxContainers {
  private readonly docker: Dockerode

  constructor(host: string | undefined) {
    this.docker = createDockerClient(host)
  }

  async reclaim(directory: string): Promise<void> {
    const images = await this.docker.listImages({})
    if (!isImagePresent(images, HELPER_IMAGE)) {
      const stream = await this.docker.pull(HELPER_IMAGE)
      await new Promise<void>((resolve, reject) =>
        this.docker.modem.followProgress(stream, (err: unknown) => (err ? reject(err) : resolve()))
      )
    }
    const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`
    // a link in the sandbox points into this container, not to the server
    const container = await this.docker.createContainer({
      Image: HELPER_IMAGE,
      Cmd: ['sh', '-c', `chown -R -h ${user} /sandbox && chmod -R u+rwX /sandbox`],
      Labels: { app: 'hammerkit' },
      NetworkDisabled: true,
      HostConfig: { Binds: [`${directory}:/sandbox`], NetworkMode: 'none' },
    })
    try {
      await container.start()
      const result = await container.wait()
      if (result.StatusCode !== 0) {
        throw new Error(`giving the files back to the server failed with ${result.StatusCode}`)
      }
    } finally {
      await container.remove({ force: true }).catch(() => undefined)
    }
  }

  private async volumes(directory: string): Promise<string[]> {
    const { Volumes } = await this.docker.listVolumes({
      filters: JSON.stringify({ label: [`${VOLUME_ROOT_LABEL}=${directory}`] }),
    })
    return (Volumes ?? []).map((volume) => volume.Name)
  }

  async volumeBytes(directory: string): Promise<number> {
    const names = new Set(await this.volumes(directory))
    if (names.size === 0) {
      return 0
    }
    const usage = await this.docker.df()
    return (usage.Volumes ?? [])
      .filter((volume: { Name: string }) => names.has(volume.Name))
      .reduce(
        (bytes: number, volume: { UsageData?: { Size?: number } }) => bytes + Math.max(0, volume.UsageData?.Size ?? 0),
        0
      )
  }

  async removeVolumes(directory: string): Promise<void> {
    for (const name of await this.volumes(directory)) {
      await this.docker.getVolume(name).remove({ force: true })
    }
  }
}
