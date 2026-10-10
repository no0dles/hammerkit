import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ImageInfo } from 'dockerode'
import { isImagePresent, normalizeArchitecture, pull, splitImageName } from './pull'
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

  function fakeDocker(images: ImageInfo[] = [], imageArchitecture = 'arm64', daemonArchitecture = 'aarch64') {
    return {
      listImages: vi.fn().mockResolvedValue(images),
      pull: vi.fn().mockResolvedValue({}),
      info: vi.fn().mockResolvedValue({ Architecture: daemonArchitecture }),
      getImage: vi.fn(() => ({ inspect: vi.fn().mockResolvedValue({ Architecture: imageArchitecture }) })),
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

  it('warns when a digest-pinned image is present for another architecture', async () => {
    const status = { write: vi.fn() }
    const pinned = `registry.example.com/org/worker:6@${DIGEST}`
    const docker = fakeDocker([image([], [`registry.example.com/org/worker@${DIGEST}`])], 'amd64', 'aarch64')
    await pull(status as any, docker as any, pinned, environment)
    expect(docker.pull).not.toHaveBeenCalled()
    expect(status.write).toHaveBeenCalledWith('warn', expect.stringContaining('runs emulated'))
    expect(status.write).toHaveBeenCalledWith(
      'warn',
      expect.stringContaining(`docker image rm registry.example.com/org/worker@${DIGEST}`)
    )
  })

  it('stays quiet when the architecture matches', async () => {
    const status = { write: vi.fn() }
    const pinned = `registry.example.com/org/native:6@${DIGEST}`
    const docker = fakeDocker([image([], [`registry.example.com/org/native@${DIGEST}`])], 'arm64', 'aarch64')
    await pull(status as any, docker as any, pinned, environment)
    expect(status.write).not.toHaveBeenCalledWith('warn', expect.anything())
  })

  it('pulls an untagged image by its own name when latest is missing', async () => {
    const status = { write: vi.fn() }
    const docker = fakeDocker([image(['alpine:3.19'], [])])
    await pull(status as any, docker as any, 'alpine', environment)
    expect(status.write).toHaveBeenCalledWith('debug', 'pull image alpine')
    expect(docker.pull).toHaveBeenCalledWith('alpine', {})
  })

  it('rejects when the pull progress reports an error', async () => {
    const docker = fakeDocker()
    docker.modem.followProgress = (_stream: unknown, done: (err: unknown, res: unknown) => void) =>
      done(new Error('pull failed'), null)
    await expect(pull({ write: vi.fn() } as any, docker as any, 'alpine:3.19', environment)).rejects.toThrow(
      'pull failed'
    )
  })

  it('rejects when the daemon refuses the pull', async () => {
    const docker = fakeDocker()
    docker.pull.mockRejectedValue(new Error('connection refused'))
    await expect(pull({ write: vi.fn() } as any, docker as any, 'alpine:3.19', environment)).rejects.toThrow(
      'connection refused'
    )
  })
})

describe('normalizeArchitecture', () => {
  it('maps the kernel names docker info reports to image architectures', () => {
    expect(normalizeArchitecture('x86_64')).toEqual('amd64')
    expect(normalizeArchitecture('aarch64')).toEqual('arm64')
    expect(normalizeArchitecture('arm64')).toEqual('arm64')
  })
})
