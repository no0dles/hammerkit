import Dockerode from 'dockerode'
import { memoryStream } from './test-streams'

// List a docker volume's top-level entries through a throwaway container, to
// assert on what a task actually left in (or restored into) its volume.
export async function listVolume(volumeName: string, image = 'alpine:3.19'): Promise<string[]> {
  const docker = new Dockerode()
  const out = memoryStream()
  const err = memoryStream()
  // Tty off (dockerode defaults it on) so the output carries no color codes;
  // passing [stdout, stderr] makes dockerode demultiplex the raw stream
  const [result] = await docker.run(image, ['ls', '-1A', '/volume'], [out.stream, err.stream], {
    Tty: false,
    HostConfig: { AutoRemove: true, Binds: [`${volumeName}:/volume`] },
  })
  if (result.StatusCode !== 0) {
    throw new Error(`listing volume ${volumeName} failed: ${err.read()}`)
  }
  return out
    .read()
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
}
