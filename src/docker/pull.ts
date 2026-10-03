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
