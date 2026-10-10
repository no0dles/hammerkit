import { mkdtempSync, existsSync, rmSync, writeFileSync, readFileSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { environmentMock } from './environment-mock'
import { pullImage, prepareVolume, prepareMounts, setUserPermissions } from './execution-steps'

vi.mock('./get-docker-executor', () => ({
  recreateVolume: vi.fn(),
  ensureVolumeExists: vi.fn(),
}))
vi.mock('../docker/pull', () => ({
  pull: vi.fn(),
}))
vi.mock('./set-user-permission', () => ({
  setUserPermission: vi.fn(),
}))

import { recreateVolume, ensureVolumeExists } from './get-docker-executor'
import { pull } from '../docker/pull'
import { setUserPermission } from './set-user-permission'

let tmpDir: string

beforeEach(() => {
  vi.clearAllMocks()
})

function makeItem(data: any) {
  return { id: () => 'i1', name: 'i1', status: { write: vi.fn() }, data } as any
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'hammerkit-execution-steps-'))
})

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('pullImage', () => {
  it('delegates to pull', async () => {
    const docker = {} as any
    const environment = environmentMock(tmpDir)
    const item = makeItem({ image: 'node:20', type: 'container-task' })
    await pullImage(item, docker, environment)
    expect(pull).toHaveBeenCalledWith(item.status, docker, 'node:20', environment)
  })
})

describe('prepareVolume', () => {
  it('recreates a service volume with resetOnChange and no inheritance', async () => {
    const docker = {} as any
    const item = makeItem({
      type: 'container-service',
      image: 'img',
      volumes: [{ name: 'vol', containerPath: '/v', resetOnChange: true, inherited: null }],
    })
    await prepareVolume(item, docker)
    expect(recreateVolume).toHaveBeenCalledWith(docker, item.status, 'vol')
    expect(ensureVolumeExists).not.toHaveBeenCalled()
  })

  it('ensures an inherited service volume exists', async () => {
    const docker = {} as any
    const item = makeItem({
      type: 'container-service',
      image: 'img',
      volumes: [{ name: 'vol', containerPath: '/v', resetOnChange: true, inherited: {} as any }],
    })
    await prepareVolume(item, docker)
    expect(ensureVolumeExists).toHaveBeenCalledWith(docker, item.status, 'vol')
    expect(recreateVolume).not.toHaveBeenCalled()
  })

  it('ensures a task generate volume exists', async () => {
    const docker = {} as any
    const item = makeItem({
      type: 'container-task',
      image: 'img',
      user: null,
      mounts: [],
      generates: [{ volumeName: 'vol', path: '/g', isFile: false, resetOnChange: false, inherited: null }],
    })
    await prepareVolume(item, docker)
    expect(ensureVolumeExists).toHaveBeenCalledWith(docker, item.status, 'vol')
    expect(recreateVolume).not.toHaveBeenCalled()
  })

  it('skips file generates on tasks', async () => {
    const docker = {} as any
    const item = makeItem({
      type: 'container-task',
      image: 'img',
      user: null,
      mounts: [],
      generates: [{ volumeName: 'vol', path: '/g', isFile: true, resetOnChange: false, inherited: null }],
    })
    await prepareVolume(item, docker)
    expect(ensureVolumeExists).not.toHaveBeenCalled()
    expect(recreateVolume).not.toHaveBeenCalled()
  })

  it('does nothing for a container-service without volumes', async () => {
    const docker = {} as any
    const item = makeItem({ type: 'container-service', image: 'img', volumes: [] })
    await prepareVolume(item, docker)
    expect(ensureVolumeExists).not.toHaveBeenCalled()
    expect(recreateVolume).not.toHaveBeenCalled()
  })
})

describe('prepareMounts', () => {
  it('writes an empty file for a missing mount with an extension', async () => {
    const environment = environmentMock(tmpDir)
    const localPath = join(tmpDir, 'file.txt')
    const item = makeItem({ type: 'container-task', image: 'img', user: null, mounts: [{ localPath }], generates: [] })
    await prepareMounts(item, environment)
    expect(existsSync(localPath)).toBe(true)
    expect(readFileSync(localPath, 'utf8')).toBe('')
  })

  it('creates a directory for a missing mount without an extension', async () => {
    const environment = environmentMock(tmpDir)
    const localPath = join(tmpDir, 'subdir')
    const item = makeItem({ type: 'container-task', image: 'img', user: null, mounts: [{ localPath }], generates: [] })
    await prepareMounts(item, environment)
    expect(existsSync(localPath)).toBe(true)
    expect(statSync(localPath).isDirectory()).toBe(true)
  })

  it('leaves an existing mount untouched', async () => {
    const environment = environmentMock(tmpDir)
    const localPath = join(tmpDir, 'exists.txt')
    writeFileSync(localPath, 'content')
    const item = makeItem({ type: 'container-task', image: 'img', user: null, mounts: [{ localPath }], generates: [] })
    await prepareMounts(item, environment)
    expect(readFileSync(localPath, 'utf8')).toBe('content')
  })

  it('writes an empty file for a missing task file generate', async () => {
    const environment = environmentMock(tmpDir)
    const path = join(tmpDir, 'out.txt')
    const item = makeItem({
      type: 'container-task',
      image: 'img',
      user: null,
      mounts: [],
      generates: [{ volumeName: 'vol', path, isFile: true, resetOnChange: false, inherited: null }],
    })
    await prepareMounts(item, environment)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8')).toBe('')
  })
})

describe('setUserPermissions', () => {
  it('does nothing when the user is null', async () => {
    const container = {} as any
    const environment = environmentMock(tmpDir)
    const item = makeItem({
      type: 'container-task',
      image: 'img',
      user: null,
      cwd: '/w',
      mounts: [],
      src: [],
      generates: [],
    })
    await setUserPermissions(item, container, environment)
    expect(setUserPermission).not.toHaveBeenCalled()
  })

  it('chowns the cwd and every bind containerPath', async () => {
    const container = {} as any
    const environment = environmentMock(tmpDir)
    const item = makeItem({
      type: 'container-task',
      image: 'img',
      user: '1000:1000',
      cwd: '/w',
      mounts: [{ localPath: '/host/mnt', containerPath: '/mnt' }],
      src: [{ absolutePath: '/host/src' }],
      generates: [
        { volumeName: 'vol1', path: '/gen/vol1', isFile: false, resetOnChange: false, inherited: null },
        { volumeName: 'vol2', path: '/gen/file.txt', isFile: true, resetOnChange: false, inherited: null },
      ],
    })
    await setUserPermissions(item, container, environment)

    expect(setUserPermission).toHaveBeenCalledTimes(5)
    expect(setUserPermission).toHaveBeenNthCalledWith(1, '/w', item.status, environment, container, '1000:1000')
    expect(setUserPermission).toHaveBeenNthCalledWith(2, '/mnt', item.status, environment, container, '1000:1000')
    expect(setUserPermission).toHaveBeenNthCalledWith(3, '/host/src', item.status, environment, container, '1000:1000')
    expect(setUserPermission).toHaveBeenNthCalledWith(4, '/gen/vol1', item.status, environment, container, '1000:1000')
    expect(setUserPermission).toHaveBeenNthCalledWith(
      5,
      '/gen/file.txt',
      item.status,
      environment,
      container,
      '1000:1000'
    )
  })
})
