import { StatusScopedConsole } from '../planner/work-item-status'
import Dockerode, { ImageInfo } from 'dockerode'
import { Environment } from '../executer/environment'
import { resolveRegistryCredentials } from '../cache/backends/registry/registry-credentials'
import { parseRegistryReference } from '../cache/backends/registry/registry-reference'

export async function pull(
  status: StatusScopedConsole,
  docker: Dockerode,
  imageName: string,
  environment: Environment
): Promise<void> {
  const images = await docker.listImages({})
  if (isImagePresent(images, imageName)) {
    await warnOnForeignPlatform(status, docker, imageName)
    return
  }

  status.write('debug', `pull image ${imageName}`)
  const authconfig = await getPullAuth(imageName, environment)
  const image = await docker.pull(imageName, authconfig ? { authconfig } : {})
  await new Promise<void>((resolve, reject) => {
    docker.modem.followProgress(image, (err: any, res: any) => (err ? reject(err) : resolve(res)))
  })
}

// A tag is present when an image carries it; an image pinned by digest
// (`repo:tag@sha256:…`) when an image was pulled with that digest, whatever
// tag it has now.
export function isImagePresent(images: ImageInfo[], imageName: string): boolean {
  const { repository, tag, digest } = splitImageName(imageName)
  if (digest) {
    return images.some((i) => i.RepoDigests?.some((repoDigest) => repoDigest === `${repository}@${digest}`))
  }
  return images.some((i) => i.RepoTags?.some((repoTag) => repoTag === `${repository}:${tag ?? 'latest'}`))
}

export function splitImageName(imageName: string): { repository: string; tag: string | null; digest: string | null } {
  const [name, digest] = imageName.split('@')
  const lastSlash = name.lastIndexOf('/')
  const tagSeparator = name.indexOf(':', lastSlash + 1)
  if (tagSeparator === -1) {
    return { repository: name, tag: null, digest: digest ?? null }
  }
  return { repository: name.substring(0, tagSeparator), tag: name.substring(tagSeparator + 1), digest: digest ?? null }
}

// The credentials `docker login` stored for the image's registry, like the
// docker CLI uses them; dockerode sends none on its own, so a private image
// could only be used when it was already present.
async function getPullAuth(
  imageName: string,
  environment: Environment
): Promise<{ username: string; password: string; serveraddress: string } | null> {
  const { repository } = splitImageName(imageName)
  const { credentialHost } = parseRegistryReference(repository)
  const credentials = await resolveRegistryCredentials(credentialHost, environment)
  if (!credentials) {
    return null
  }
  return { ...credentials, serveraddress: credentialHost }
}

const daemonArchitectures = new WeakMap<Dockerode, Promise<string>>()
const warnedImages = new Set<string>()

// A digest pins a multi-arch index; a copy pulled earlier for another
// architecture (an amd64 one from a Compose file with `platform:`) carries the
// same digest, so docker uses it and the image runs emulated instead of native.
async function warnOnForeignPlatform(status: StatusScopedConsole, docker: Dockerode, imageName: string): Promise<void> {
  const { repository, digest } = splitImageName(imageName)
  if (!digest || warnedImages.has(imageName)) {
    return
  }
  try {
    if (!daemonArchitectures.has(docker)) {
      daemonArchitectures.set(
        docker,
        docker.info().then((info: { Architecture?: string }) => normalizeArchitecture(info.Architecture ?? ''))
      )
    }
    const [image, daemonArchitecture] = await Promise.all([
      docker.getImage(imageName).inspect(),
      daemonArchitectures.get(docker) as Promise<string>,
    ])
    const imageArchitecture = normalizeArchitecture(image.Architecture ?? '')
    if (!imageArchitecture || !daemonArchitecture || imageArchitecture === daemonArchitecture) {
      return
    }
    warnedImages.add(imageName)
    status.write(
      'warn',
      `image ${imageName} is present for ${imageArchitecture} on this ${daemonArchitecture} docker host and runs ` +
        `emulated; if the digest is a multi-arch index, remove the copy to pull the native one: ` +
        `docker image rm ${repository}@${digest}`
    )
  } catch {
    // only a hint: never fail a pull over it
  }
}

export function normalizeArchitecture(architecture: string): string {
  const aliases: { [key: string]: string } = { x86_64: 'amd64', aarch64: 'arm64' }
  return aliases[architecture] ?? architecture
}
