export interface RegistryReference {
  // host[:port] used in URLs, e.g. `ghcr.io`, `localhost:5000`, `registry-1.docker.io`
  host: string
  // repository path, e.g. `org/hammerkit-cache`
  repository: string
  // host the credentials are stored under in the docker config
  credentialHost: string
  // plain http (a localhost registry, or `insecure: true`)
  insecure: boolean
}

const DOCKER_HUB_HOST = 'registry-1.docker.io'
const DOCKER_HUB_CREDENTIAL_HOST = 'https://index.docker.io/v1/'

function isLocalHost(host: string): boolean {
  const name = host.replace(/:\d+$/, '')
  return name === 'localhost' || name === '127.0.0.1' || name === '[::1]'
}

// Parse a repository reference the way docker does: the first path component is
// a registry host when it contains a `.` or `:` or is `localhost`; otherwise the
// repository lives on Docker Hub (with the implicit `library/` namespace).
export function parseRegistryReference(value: string, insecure?: boolean): RegistryReference {
  const trimmed = value.replace(/^[a-z]+:\/\//, '').replace(/\/+$/, '')
  if (trimmed.includes('@') || /:[^/]*$/.test(trimmed.split('/').slice(1).join('/'))) {
    throw new Error(`registry cache repository "${value}" must not contain a tag or digest`)
  }
  const [first, ...rest] = trimmed.split('/')
  const hasHost = rest.length > 0 && (first.includes('.') || first.includes(':') || first === 'localhost')

  if (!hasHost) {
    const repository = rest.length === 0 ? `library/${first}` : trimmed
    return { host: DOCKER_HUB_HOST, repository, credentialHost: DOCKER_HUB_CREDENTIAL_HOST, insecure: false }
  }

  const host = first === 'docker.io' || first === 'index.docker.io' ? DOCKER_HUB_HOST : first
  if (rest.length === 0) {
    throw new Error(`registry cache repository "${value}" has no repository path`)
  }
  return {
    host,
    repository: rest.join('/'),
    credentialHost: host === DOCKER_HUB_HOST ? DOCKER_HUB_CREDENTIAL_HOST : host,
    insecure: insecure ?? isLocalHost(host),
  }
}
