import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cleanCache, getArchivePaths, restoreCache, storeCache } from './event-cache'
import { environmentMock } from './environment-mock'
import { getCacheDirectory, getHammerkitDirectory } from '../optimizer/get-cache-directory'
import { getWorkInstanceId } from '../planner/work-instance-id'
import { removeOrphanedContainers } from '../docker/remove-orphaned-containers'

vi.mock('../docker/remove-orphaned-containers', () => ({ removeOrphanedContainers: vi.fn() }))
vi.mock('./execute-docker', () => ({ getContainerCli: vi.fn(() => ({ docker: true })) }))

const cacheId = 't1'
// the staging directory is per checkout: keyed by the id and the project root
const projectRoot = join(tmpdir(), 'hammerkit-event-cache-project')
const cachePath = getCacheDirectory(getWorkInstanceId({ id: () => cacheId, data: { projectRoot } } as any))

describe('getArchivePaths', () => {
  it('yields one archive per non-inherited container-service volume', () => {
    const service = {
      type: 'container-service',
      volumes: [
        { name: 'v1', containerPath: '/data', inherited: null },
        { name: 'v2', containerPath: '/v2', inherited: {} },
      ],
    } as any

    const result = Array.from(getArchivePaths(service, '/cache'))
    expect(result).toEqual([{ filename: join('/cache', 'v1-volume.tgz'), path: '/data' }])
  })

  it('yields one archive per non-inherited task generate, path flattened with dashes', () => {
    const cwd = process.cwd()
    const task = {
      type: 'local-task',
      cwd,
      generates: [
        { path: join(cwd, 'dist'), volumeName: 'x', inherited: null, isFile: false },
        { path: join(cwd, 'other'), volumeName: 'y', inherited: {} },
      ],
    } as any

    const result = Array.from(getArchivePaths(task, '/cache'))
    expect(result).toEqual([{ filename: join('/cache', 'dist-generates.tgz'), path: join(cwd, 'dist') }])
  })

  it('flattens nested relative paths with the path separator replaced', () => {
    const cwd = process.cwd()
    const nested = join(cwd, 'dist', 'sub', 'out')
    const task = {
      type: 'local-task',
      cwd,
      generates: [{ path: nested, volumeName: 'x', inherited: null, isFile: false }],
    } as any

    const result = Array.from(getArchivePaths(task, '/cache'))
    expect(result).toEqual([{ filename: join('/cache', 'dist-sub-out-generates.tgz'), path: nested }])
  })
})

describe('restoreCache', () => {
  let path: string
  let environment: ReturnType<typeof environmentMock>

  beforeAll(() => {
    path = mkdtempSync(join(tmpdir(), 'hammerkit-restore-'))
    environment = environmentMock(path)
  })

  afterAll(() => {
    rmSync(path, { recursive: true, force: true })
    rmSync(cachePath, { recursive: true, force: true })
  })

  it('copies the stored stats and description into the hammerkit cache and restores the runtime', async () => {
    const taskDir = join(path, cacheId)
    mkdirSync(taskDir, { recursive: true })
    writeFileSync(join(taskDir, 'stats.json'), '{"files":{}}')
    writeFileSync(join(taskDir, 'description.json'), '{"name":"t1"}')

    const restore = vi.fn()
    const workTree = {
      tasks: {
        t1: {
          id: () => cacheId,
          name: cacheId,
          status: { write: vi.fn() },
          runtime: { restore },
          data: { projectRoot },
        },
      },
      services: {},
    } as any

    await restoreCache(environment, path, workTree)

    expect(existsSync(join(cachePath, 'stats.json'))).toBe(true)
    expect(existsSync(join(cachePath, 'description.json'))).toBe(true)
    expect(readFileSync(join(cachePath, 'stats.json'), 'utf-8')).toBe('{"files":{}}')
    expect(readFileSync(join(cachePath, 'description.json'), 'utf-8')).toBe('{"name":"t1"}')
    expect(restore).toHaveBeenCalledWith(environment, join(path, cacheId))
  })
})

describe('storeCache', () => {
  let path: string
  let environment: ReturnType<typeof environmentMock>

  beforeAll(() => {
    path = mkdtempSync(join(tmpdir(), 'hammerkit-store-'))
    environment = environmentMock(path)
  })

  afterAll(() => {
    rmSync(path, { recursive: true, force: true })
    rmSync(cachePath, { recursive: true, force: true })
  })

  it('copies the hammerkit cache into the target directory and archives it', async () => {
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'stats.json'), '{"stored":true}')

    const archive = vi.fn()
    const workTree = {
      tasks: {
        t1: {
          id: () => cacheId,
          name: cacheId,
          status: { write: vi.fn() },
          runtime: { archive },
          data: { projectRoot },
        },
      },
      services: {},
    } as any

    await storeCache(environment, path, workTree)

    expect(existsSync(join(path, cacheId, 'stats.json'))).toBe(true)
    expect(readFileSync(join(path, cacheId, 'stats.json'), 'utf-8')).toBe('{"stored":true}')
    // storeCache creates the source directory even when a file is missing
    expect(existsSync(join(path, cacheId, 'description.json'))).toBe(false)
    expect(archive).toHaveBeenCalledWith(environment, join(path, cacheId))
  })
})

describe('cleanCache', () => {
  let path: string
  let environment: ReturnType<typeof environmentMock>

  beforeEach(() => {
    path = mkdtempSync(join(tmpdir(), 'hammerkit-clean-'))
    environment = environmentMock(path)
  })

  afterEach(() => {
    rmSync(path, { recursive: true, force: true })
    rmSync(cachePath, { recursive: true, force: true })
  })

  it('removes the runtime, clears the cache backend and deletes the cache directory', async () => {
    mkdirSync(cachePath, { recursive: true })
    writeFileSync(join(cachePath, 'stats.json'), '{}')

    const remove = vi.fn()
    const clear = vi.fn()
    const workTree = {
      tasks: {
        t1: {
          id: () => cacheId,
          name: cacheId,
          status: { write: vi.fn() },
          runtime: { remove },
          data: {
            type: 'local-task',
            projectRoot,
            caching: { name: 'default', method: 'none', backend: { clear }, implicit: true },
          },
        },
      },
      services: {},
      environment: { type: 'kubernetes' },
    } as any

    await cleanCache(workTree, environment, { cache: true })

    expect(remove).toHaveBeenCalledWith(environment)
    expect(clear).toHaveBeenCalledWith(cacheId, environment)
    expect(existsSync(cachePath)).toBe(false)
  })

  it('removes the runtime without touching the backend when caching is not requested', async () => {
    const remove = vi.fn()
    const clear = vi.fn()
    const workTree = {
      tasks: {
        t1: {
          id: () => cacheId,
          name: cacheId,
          status: { write: vi.fn() },
          runtime: { remove },
          data: {
            type: 'local-task',
            projectRoot,
            caching: { name: 'default', method: 'none', backend: { clear }, implicit: true },
          },
        },
      },
      services: {},
      environment: { type: 'kubernetes' },
    } as any

    await cleanCache(workTree, environment)

    expect(remove).toHaveBeenCalledWith(environment)
    expect(clear).not.toHaveBeenCalled()
    expect(removeOrphanedContainers).not.toHaveBeenCalled()
  })

  it('clears services and removes containers left behind on docker', async () => {
    vi.mocked(removeOrphanedContainers).mockResolvedValue(['0123456789abcdef'])
    const info = vi.spyOn(environment.console, 'info')
    const remove = vi.fn()
    const clear = vi.fn()
    const workTree = {
      tasks: {},
      services: {
        s1: {
          id: () => 's1',
          name: 's1',
          status: { write: vi.fn() },
          runtime: { remove },
          data: { type: 'container-service', projectRoot, caching: { backend: { clear } } },
        },
      },
      environment: { type: 'docker' },
    } as any

    await cleanCache(workTree, environment, { cache: true })

    expect(remove).toHaveBeenCalledWith(environment)
    expect(clear).toHaveBeenCalledWith('s1', environment)
    expect(removeOrphanedContainers).toHaveBeenCalledWith({ docker: true })
    expect(info).toHaveBeenCalledWith('removed container 0123456789ab left behind by a stopped run')
  })
})

describe('cache directory contract', () => {
  it('places the per-task cache under the hammerkit directory', () => {
    expect(getHammerkitDirectory()).toContain('hammerkit')
    expect(getCacheDirectory('t1')).toContain(join('cache', 't1'))
  })
})
