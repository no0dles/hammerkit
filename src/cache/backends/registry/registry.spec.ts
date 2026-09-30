import { createServer, IncomingMessage, Server, ServerResponse } from 'http'
import { AddressInfo } from 'net'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { parseRegistryReference } from './registry-reference'
import { parseChallenge, RegistryClient } from './registry-client'
import { resolveRegistryCredentials } from './registry-credentials'
import { entryTag } from '../registry-cache-backend'
import { environmentMock } from '../../../executer/environment-mock'
import { Environment } from '../../../executer/environment'
import { getFileContext } from '../../../file/get-file-context'

describe('parseRegistryReference', () => {
  it('parses a registry host with a nested repository', () => {
    expect(parseRegistryReference('ghcr.io/org/team/cache')).toEqual({
      host: 'ghcr.io',
      repository: 'org/team/cache',
      credentialHost: 'ghcr.io',
      insecure: false,
    })
  })

  it('treats localhost registries as plain http', () => {
    expect(parseRegistryReference('localhost:5000/cache')).toMatchObject({ host: 'localhost:5000', insecure: true })
    expect(parseRegistryReference('127.0.0.1:5000/cache')).toMatchObject({ insecure: true })
  })

  it('honors an explicit insecure flag', () => {
    expect(parseRegistryReference('registry.internal:5000/cache', true)).toMatchObject({ insecure: true })
  })

  it('maps Docker Hub references, including the implicit library namespace', () => {
    expect(parseRegistryReference('myorg/cache')).toEqual({
      host: 'registry-1.docker.io',
      repository: 'myorg/cache',
      credentialHost: 'https://index.docker.io/v1/',
      insecure: false,
    })
    expect(parseRegistryReference('cache')).toMatchObject({ repository: 'library/cache' })
    expect(parseRegistryReference('docker.io/myorg/cache')).toMatchObject({
      host: 'registry-1.docker.io',
      repository: 'myorg/cache',
    })
  })

  it('rejects a tag or digest in the repository', () => {
    expect(() => parseRegistryReference('ghcr.io/org/cache:latest')).toThrow(/tag or digest/)
    expect(() => parseRegistryReference('ghcr.io/org/cache@sha256:abc')).toThrow(/tag or digest/)
  })
})

describe('entryTag', () => {
  it('joins task id and state key', () => {
    expect(entryTag('a'.repeat(40), 'b'.repeat(32))).toBe(`${'a'.repeat(40)}-${'b'.repeat(32)}`)
  })

  it('hashes a state key that would exceed the tag length limit', () => {
    const tag = entryTag('a'.repeat(40), 'b'.repeat(200))
    expect(tag.length).toBeLessThanOrEqual(128)
    expect(tag.startsWith(`${'a'.repeat(40)}-`)).toBe(true)
  })
})

describe('parseChallenge', () => {
  it('parses a bearer challenge', () => {
    expect(
      parseChallenge('Bearer realm="https://ghcr.io/token",service="ghcr.io",scope="repository:o/r:pull"')
    ).toEqual({
      scheme: 'bearer',
      params: { realm: 'https://ghcr.io/token', service: 'ghcr.io', scope: 'repository:o/r:pull' },
    })
  })

  it('parses a basic challenge', () => {
    expect(parseChallenge('Basic realm="Registry Realm"')).toEqual({
      scheme: 'basic',
      params: { realm: 'Registry Realm' },
    })
  })
})

describe('resolveRegistryCredentials', () => {
  let dir: string
  let environment: Environment

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hammerkit-docker-config-'))
    environment = { ...environmentMock(dir), file: getFileContext(dir), processEnvs: { DOCKER_CONFIG: dir } }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('reads inline base64 auths written by docker login', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ auths: { 'ghcr.io': { auth: Buffer.from('me:tok:en').toString('base64') } } })
    )
    expect(await resolveRegistryCredentials('ghcr.io', environment)).toEqual({ username: 'me', password: 'tok:en' })
  })

  it('returns null without a docker config or a matching entry', async () => {
    expect(await resolveRegistryCredentials('ghcr.io', environment)).toBeNull()
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ auths: { 'other.io': { auth: 'eDp5' } } }))
    expect(await resolveRegistryCredentials('ghcr.io', environment)).toBeNull()
  })

  const itExceptWindows = process.platform === 'win32' ? it.skip : it
  itExceptWindows('asks the configured credential helper', async () => {
    const helper = join(dir, 'docker-credential-fake')
    writeFileSync(helper, '#!/bin/sh\nread host\necho "{\\"Username\\":\\"u-$host\\",\\"Secret\\":\\"s3cret\\"}"\n')
    chmodSync(helper, 0o755)
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ credHelpers: { 'ghcr.io': 'fake' } }))
    const previousPath = process.env.PATH
    process.env.PATH = `${dir}${delimiter}${previousPath}`
    try {
      expect(await resolveRegistryCredentials('ghcr.io', environment)).toEqual({
        username: 'u-ghcr.io',
        password: 's3cret',
      })
    } finally {
      process.env.PATH = previousPath
    }
  })
})

// The bearer-token handshake cannot be exercised against a stock registry:2
// without a token server, so a minimal fake registry + token endpoint verifies
// the flow: 401 challenge → token request with basic credentials → retry.
describe('RegistryClient bearer auth', () => {
  let server: Server
  let port: number
  let dir: string
  const tokenRequests: string[] = []

  beforeAll(async () => {
    server = createServer((req: IncomingMessage, res: ServerResponse) => {
      if (req.url?.startsWith('/token')) {
        tokenRequests.push(`${req.url} ${req.headers.authorization}`)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ token: 'the-token' }))
        return
      }
      if (req.headers.authorization !== 'Bearer the-token') {
        res.writeHead(401, {
          'www-authenticate': `Bearer realm="http://127.0.0.1:${port}/token",service="fake"`,
        })
        res.end()
        return
      }
      res.writeHead(req.url?.endsWith('/manifests/present') ? 200 : 404)
      res.end()
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    port = (server.address() as AddressInfo).port
    dir = mkdtempSync(join(tmpdir(), 'hammerkit-docker-config-'))
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ auths: { [`127.0.0.1:${port}`]: { auth: Buffer.from('me:pw').toString('base64') } } })
    )
  })

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve))
    rmSync(dir, { recursive: true, force: true })
  })

  it('fetches a token with the stored credentials and retries the request', async () => {
    const environment: Environment = {
      ...environmentMock(dir),
      file: getFileContext(dir),
      processEnvs: { DOCKER_CONFIG: dir },
    }
    const client = new RegistryClient(parseRegistryReference(`127.0.0.1:${port}/org/cache`), environment)
    expect(await client.manifestExists('present')).toBe(true)
    expect(await client.manifestExists('absent')).toBe(false)
    expect(tokenRequests).toHaveLength(1)
    expect(tokenRequests[0]).toContain('scope=repository%3Aorg%2Fcache%3Apull%2Cpush')
    expect(tokenRequests[0]).toContain(`Basic ${Buffer.from('me:pw').toString('base64')}`)
  })
})
