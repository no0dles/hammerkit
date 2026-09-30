import { createHash } from 'crypto'
import { createReadStream, createWriteStream } from 'fs'
import { stat } from 'fs/promises'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import { Environment } from '../../../executer/environment'
import { RegistryReference } from './registry-reference'
import { RegistryCredentials, resolveRegistryCredentials } from './registry-credentials'

export const OCI_MANIFEST = 'application/vnd.oci.image.manifest.v1+json'
export const OCI_CONFIG = 'application/vnd.oci.image.config.v1+json'
export const OCI_LAYER_TAR = 'application/vnd.oci.image.layer.v1.tar'

const MANIFEST_ACCEPT = [OCI_MANIFEST, 'application/vnd.docker.distribution.manifest.v2+json'].join(', ')

export interface Descriptor {
  mediaType: string
  digest: string
  size: number
}

export interface ImageManifest {
  schemaVersion: 2
  mediaType: string
  config: Descriptor
  layers: Descriptor[]
}

export class RegistryError extends Error {
  constructor(
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

interface Challenge {
  scheme: string
  params: { [key: string]: string }
}

// Parse a `WWW-Authenticate` header, e.g.
// `Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/r:pull"`
export function parseChallenge(header: string): Challenge {
  const space = header.indexOf(' ')
  const scheme = (space < 0 ? header : header.substring(0, space)).toLowerCase()
  const params: { [key: string]: string } = {}
  const regex = /([a-zA-Z_]+)="([^"]*)"/g
  let match: RegExpExecArray | null
  while ((match = regex.exec(header)) !== null) {
    params[match[1]] = match[2]
  }
  return { scheme, params }
}

function basicHeader(credentials: RegistryCredentials): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
}

// A minimal OCI distribution-spec client: just the manifest/blob operations the
// cache backend needs, with the Basic and Bearer-token auth handshakes every
// mainstream registry (Docker Hub, GHCR, ECR, GAR, Artifactory, registry:2)
// uses. Talks HTTP directly so no docker daemon or extra binary is involved.
export class RegistryClient {
  private authorization: string | null = null
  private credentials: RegistryCredentials | null | undefined = undefined

  constructor(
    private readonly reference: RegistryReference,
    private readonly environment: Environment
  ) {}

  private url(path: string): string {
    const scheme = this.reference.insecure ? 'http' : 'https'
    return `${scheme}://${this.reference.host}/v2/${this.reference.repository}/${path}`
  }

  private async getCredentials(): Promise<RegistryCredentials | null> {
    if (this.credentials === undefined) {
      this.credentials = await resolveRegistryCredentials(this.reference.credentialHost, this.environment)
    }
    return this.credentials
  }

  private async authenticate(challengeHeader: string | null): Promise<boolean> {
    if (!challengeHeader) {
      return false
    }
    const challenge = parseChallenge(challengeHeader)
    const credentials = await this.getCredentials()
    if (challenge.scheme === 'basic') {
      if (!credentials) {
        return false
      }
      this.authorization = basicHeader(credentials)
      return true
    }
    if (challenge.scheme !== 'bearer' || !challenge.params.realm) {
      return false
    }
    const tokenUrl = new URL(challenge.params.realm)
    if (challenge.params.service) {
      tokenUrl.searchParams.set('service', challenge.params.service)
    }
    // always ask for push too: one token then serves the whole backend; a
    // registry grants the subset the credentials allow
    tokenUrl.searchParams.set('scope', `repository:${this.reference.repository}:pull,push`)
    const response = await fetch(tokenUrl, {
      headers: credentials ? { authorization: basicHeader(credentials) } : {},
    })
    if (!response.ok) {
      throw new RegistryError(`registry token request failed with ${response.status}`, response.status)
    }
    const body = (await response.json()) as { token?: string; access_token?: string }
    const token = body.token ?? body.access_token
    if (!token) {
      throw new RegistryError('registry token response contained no token')
    }
    this.authorization = `Bearer ${token}`
    return true
  }

  // Send a request, performing the auth handshake once on a 401. `body` is a
  // factory because a streamed body cannot be replayed after the challenge.
  async request(
    method: string,
    urlOrPath: string,
    init: {
      headers?: { [key: string]: string }
      body?: () => string | Buffer | Readable
      redirect?: 'follow' | 'manual'
    } = {}
  ): Promise<Response> {
    const url = urlOrPath.startsWith('http') ? urlOrPath : this.url(urlOrPath)
    const send = () => {
      const body = init.body?.()
      return fetch(url, {
        method,
        headers: { ...(init.headers ?? {}), ...(this.authorization ? { authorization: this.authorization } : {}) },
        body: body instanceof Readable ? (Readable.toWeb(body) as ReadableStream) : body,
        redirect: init.redirect ?? 'follow',
        ...(body instanceof Readable ? { duplex: 'half' } : {}),
      } as RequestInit)
    }
    let response = await send()
    if (response.status === 401 && (await this.authenticate(response.headers.get('www-authenticate')))) {
      await response.body?.cancel()
      response = await send()
    }
    return response
  }

  private async fail(response: Response, what: string): Promise<never> {
    const text = await response.text().catch(() => '')
    const hint = response.status === 401 || response.status === 403 ? ' (check `docker login` for this registry)' : ''
    throw new RegistryError(
      `${what} failed with ${response.status} ${text.substring(0, 200)}${hint}`.trim(),
      response.status
    )
  }

  async manifestExists(tag: string): Promise<boolean> {
    const response = await this.request('HEAD', `manifests/${tag}`, { headers: { accept: MANIFEST_ACCEPT } })
    if (response.status === 404) {
      return false
    }
    if (!response.ok) {
      return this.fail(response, `checking manifest ${tag}`)
    }
    return true
  }

  async getManifest(tag: string): Promise<ImageManifest | null> {
    const response = await this.request('GET', `manifests/${tag}`, { headers: { accept: MANIFEST_ACCEPT } })
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      return this.fail(response, `reading manifest ${tag}`)
    }
    return (await response.json()) as ImageManifest
  }

  async manifestDigest(tag: string): Promise<string | null> {
    const response = await this.request('HEAD', `manifests/${tag}`, { headers: { accept: MANIFEST_ACCEPT } })
    if (response.status === 404) {
      return null
    }
    if (!response.ok) {
      return this.fail(response, `checking manifest ${tag}`)
    }
    return response.headers.get('docker-content-digest')
  }

  async putManifest(tag: string, manifest: ImageManifest): Promise<void> {
    const body = JSON.stringify(manifest)
    const response = await this.request('PUT', `manifests/${tag}`, {
      headers: { 'content-type': OCI_MANIFEST },
      body: () => body,
    })
    if (!response.ok) {
      return this.fail(response, `writing manifest ${tag}`)
    }
  }

  async deleteManifest(digest: string): Promise<void> {
    const response = await this.request('DELETE', `manifests/${digest}`)
    if (response.status === 404) {
      return
    }
    if (response.status === 405) {
      throw new RegistryError('the registry does not allow deleting manifests', 405)
    }
    if (!response.ok) {
      return this.fail(response, `deleting manifest ${digest}`)
    }
  }

  async listTags(): Promise<string[]> {
    const tags: string[] = []
    let next: string | null = 'tags/list?n=1000'
    while (next) {
      const response = await this.request('GET', next)
      if (response.status === 404) {
        return tags
      }
      if (!response.ok) {
        return this.fail(response, 'listing tags')
      }
      const body = (await response.json()) as { tags?: string[] | null }
      tags.push(...(body.tags ?? []))
      const link = response.headers.get('link')
      const match = link ? /<([^>]+)>;\s*rel="next"/.exec(link) : null
      next = match ? new URL(match[1], this.url('')).toString() : null
    }
    return tags
  }

  async blobExists(digest: string): Promise<boolean> {
    const response = await this.request('HEAD', `blobs/${digest}`)
    if (response.status === 404) {
      return false
    }
    if (!response.ok) {
      return this.fail(response, `checking blob ${digest}`)
    }
    return true
  }

  // Upload a blob from a buffer or a file (monolithic upload: POST to open the
  // session, PUT the content with its digest to commit it).
  async uploadBlob(digest: string, size: number, content: { buffer: Buffer } | { file: string }): Promise<void> {
    if (await this.blobExists(digest)) {
      return
    }
    const started = await this.request('POST', 'blobs/uploads/', { redirect: 'manual' })
    if (started.status !== 202) {
      return this.fail(started, 'starting blob upload')
    }
    const location = started.headers.get('location')
    if (!location) {
      throw new RegistryError('registry did not return an upload location')
    }
    const uploadUrl = new URL(location, this.url(''))
    uploadUrl.searchParams.set('digest', digest)
    const response = await this.request('PUT', uploadUrl.toString(), {
      headers: { 'content-type': 'application/octet-stream', 'content-length': `${size}` },
      body: () => ('buffer' in content ? content.buffer : createReadStream(content.file)),
    })
    if (response.status !== 201) {
      return this.fail(response, `uploading blob ${digest}`)
    }
  }

  // Download a blob to a file, verifying its digest while streaming.
  async downloadBlob(descriptor: Descriptor, file: string): Promise<void> {
    const response = await this.request('GET', `blobs/${descriptor.digest}`)
    if (!response.ok || !response.body) {
      return this.fail(response, `downloading blob ${descriptor.digest}`)
    }
    const hash = createHash('sha256')
    await pipeline(
      Readable.fromWeb(response.body as any),
      new Transform({
        transform(chunk, _encoding, callback) {
          hash.update(chunk)
          callback(null, chunk)
        },
      }),
      createWriteStream(file)
    )
    const actual = `sha256:${hash.digest('hex')}`
    if (actual !== descriptor.digest) {
      throw new RegistryError(`blob digest mismatch: expected ${descriptor.digest}, got ${actual}`)
    }
  }
}

export async function digestFile(file: string): Promise<{ digest: string; size: number }> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return { digest: `sha256:${hash.digest('hex')}`, size: (await stat(file)).size }
}

export function digestBuffer(buffer: Buffer): { digest: string; size: number } {
  return { digest: `sha256:${createHash('sha256').update(buffer).digest('hex')}`, size: buffer.length }
}
