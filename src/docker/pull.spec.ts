import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ImageInfo } from 'dockerode'
import { isImagePresent, pull, splitImageName } from './pull'
import { environmentMock } from '../executer/environment-mock'
import { getFileContext } from '../file/get-file-context'
import { Environment } from '../executer/environment'

const DIGEST = 'sha256:38478af9caae1494c2f07182663436d5c994f970173707eed7b91b2c0a29bcb3'

function image(tags: string[], digests: string[]): ImageInfo {
  return { RepoTags: tags, RepoDigests: digests } as unknown as ImageInfo
}

describe('splitImageName', () => {
  it('splits repository, tag and digest', () => {
    expect(splitImageName(`registry.example.com/org/api:6.5@${DIGEST}`)).toEqual({
      repository: 'registry.example.com/org/api',
      tag: '6.5',
      digest: DIGEST,
    })
    expect(splitImageName('localhost:5000/api')).toEqual({ repository: 'localhost:5000/api', tag: null, digest: null })
    expect(splitImageName(`alpine@${DIGEST}`)).toEqual({ repository: 'alpine', tag: null, digest: DIGEST })
  })
})

describe('isImagePresent', () => {
  it('finds a tag, defaulting to latest', () => {
    expect(isImagePresent([image(['alpine:latest'], [])], 'alpine')).toBe(true)
    expect(isImagePresent([image(['alpine:3.19'], [])], 'alpine')).toBe(false)
  })

  it('finds an image pinned by digest whatever its tag', () => {
    const pulled = image(['registry.example.com/org/api:6.5'], [`registry.example.com/org/api@${DIGEST}`])
    expect(isImagePresent([pulled], `registry.example.com/org/api:6.5@${DIGEST}`)).toBe(true)
    expect(isImagePresent([pulled], `registry.example.com/org/api:6.6@${DIGEST}`)).toBe(true)
    expect(
      isImagePresent([image(['registry.example.com/org/api:6.5'], [])], `registry.example.com/org/api:6.5@${DIGEST}`)
    ).toBe(false)
  })
})

describe('pull', () => {
  let dir: string
  let environment: Environment

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'hammerkit-pull-'))
    environment = { ...environmentMock(dir), file: getFileContext(dir), processEnvs: { DOCKER_CONFIG: dir } }
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function fakeDocker(images: ImageInfo[] = []) {
    return {
      listImages: vi.fn().mockResolvedValue(images),
      pull: vi.fn().mockResolvedValue({}),
      modem: { followProgress: (_stream: unknown, done: (err: unknown, res: unknown) => void) => done(null, []) },
    }
  }

  it('sends the credentials docker login stored for the registry', async () => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ auths: { 'registry.example.com': { auth: Buffer.from('me:secret').toString('base64') } } })
    )
    const docker = fakeDocker()
    await pull(
      environment.status.context({ type: 'task', name: 't' } as any),
      docker as any,
      'registry.example.com/org/api:6',
      environment
    )
    expect(docker.pull).toHaveBeenCalledWith('registry.example.com/org/api:6', {
      authconfig: { username: 'me', password: 'secret', serveraddress: 'registry.example.com' },
    })
  })

  it('pulls anonymously without stored credentials', async () => {
    const docker = fakeDocker()
    await pull(
      environment.status.context({ type: 'task', name: 't' } as any),
      docker as any,
      'alpine:3.19',
      environment
    )
    expect(docker.pull).toHaveBeenCalledWith('alpine:3.19', {})
  })

  it('does not pull an image pinned by a digest it already has', async () => {
    const docker = fakeDocker([image(['registry.example.com/org/api:6'], [`registry.example.com/org/api@${DIGEST}`])])
    await pull(
      environment.status.context({ type: 'task', name: 't' } as any),
      docker as any,
      `registry.example.com/org/api:6@${DIGEST}`,
      environment
    )
    expect(docker.pull).not.toHaveBeenCalled()
  })
})
