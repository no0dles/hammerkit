import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { environmentMock } from '../executer/environment-mock'
import { checkCacheState } from '../executer/scheduler/enqueue-next'
import { createLocalCacheBackend } from './backends/local-cache-backend'
import { State } from '../executer/state'
import { TaskState } from '../executer/scheduler/task-state'
import { WorkItemState } from '../planner/work-item'
import { LocalWorkTask } from '../planner/work-task'
import { ResolvedCache } from './resolve-cache'
import { writeCacheMetadata } from '../executer/cache-metadata'
import { getCacheDirectory } from '../optimizer/get-cache-directory'
import { getWorkInstanceId } from '../planner/work-instance-id'
import { getWorkCacheStats, getStateKey } from '../optimizer/get-work-cache-stats'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { restoreDeferred } from '../executer/deferred-restore'
import { CacheBackend } from './cache-backend'

describe('checkCacheState auto-pull', () => {
  let remoteDir: string
  let machineHome: string
  let originalHome: string | undefined

  beforeEach(() => {
    remoteDir = mkdtempSync(join(tmpdir(), 'hammerkit-remote-'))
    machineHome = mkdtempSync(join(tmpdir(), 'hammerkit-home-'))
    originalHome = process.env.HOME
    if (process.platform === 'darwin') {
      // getHammerkitDirectory uses Library/Application Support on macOS
      process.env.HOME = machineHome
    } else if (process.platform === 'win32') {
      process.env.APPDATA = machineHome
    } else {
      process.env.HOME = machineHome
    }
  })

  afterEach(() => {
    rmSync(remoteDir, { recursive: true, force: true })
    rmSync(machineHome, { recursive: true, force: true })
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
  })

  function makeBackend() {
    return createLocalCacheBackend({ type: 'local', path: remoteDir })
  }

  function makeWorkItem(cwd: string, resolved: ResolvedCache): WorkItemState<LocalWorkTask, TaskState> {
    // identical source content on every "machine", so the state keys match
    const input = join(cwd, 'input.txt')
    writeFileSync(input, 'same on every machine')
    const storedStateKey: string | null = null
    return {
      id: () => 'demo-task',
      name: 'demo-task',
      status: { write: vi.fn() } as any,
      data: {
        type: 'local-task',
        envOrigins: {},
        name: 'demo-task',
        cwd,
        projectRoot: cwd,
        cmds: [],
        generates: [],
        src: [
          {
            absolutePath: input,
            source: 'input.txt',
            matcher: (file: string) => file.startsWith(input),
            inherited: null,
            isFile: true,
          },
        ],
        envs: { variables: {}, replacements: [] } as any,
        labels: {},
        shell: '/bin/sh',
        timeout: null,
        secrets: [],
        resources: null,
        network: { type: 'open' },
        networkCeiling: null,
        runner: null,
        args: null,
        caching: resolved,
        description: null,
        scope: {} as any,
      },
      needs: [],
      deps: [],
      requiredBy: [],
      state: new State<TaskState>({ type: 'pending', stateKey: null }),
      runtime: {
        async initialize() {},
        async remove() {},
        async execute() {},
        async stop() {},
        async archive() {},
        async restore() {
          // simulate a successful artifact restore
        },
        async currentStateKey() {
          return storedStateKey
        },
      },
    }
  }

  it('reports cached:true on the second machine after the first pushed', async () => {
    // Machine A: produce cache + push to remote
    const machineAScratch = mkdtempSync(join(tmpdir(), 'hammerkit-machine-a-'))
    const envA = environmentMock(machineAScratch)
    const backend = makeBackend()
    const resolved: ResolvedCache = { name: 'remote', method: 'checksum', backend, implicit: false }
    const itemA = makeWorkItem(machineAScratch, resolved)

    const stats = await getWorkCacheStats(itemA.data, envA)
    const stateKey = getStateKey(stats, 'checksum')

    await writeCacheMetadata(envA, itemA, stats, getWorkTaskCacheDescription(itemA))
    const cacheDir = getCacheDirectory(getWorkInstanceId(itemA))
    await backend.push(itemA.id(), stateKey, cacheDir, envA)

    rmSync(machineAScratch, { recursive: true, force: true })

    // Machine B (different HOME = fresh local cache): same task, same sources → same stateKey
    const machineBScratch = mkdtempSync(join(tmpdir(), 'hammerkit-machine-b-'))
    const envB = environmentMock(machineBScratch)
    // simulate a *different* machine: reset the HOME again
    const machineBHome = mkdtempSync(join(tmpdir(), 'hammerkit-home-b-'))
    process.env.HOME = machineBHome

    const itemB = makeWorkItem(machineBScratch, resolved)
    const cacheState = await checkCacheState(itemB, 'checksum', envB)

    expect(cacheState.stateKey).toBe(stateKey)
    expect(cacheState.cached).toBe(true)

    rmSync(machineBScratch, { recursive: true, force: true })
    rmSync(machineBHome, { recursive: true, force: true })
  })

  it('reports cached:false when remote has nothing', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'hammerkit-machine-c-'))
    const env = environmentMock(scratch)
    const backend = makeBackend()
    const resolved: ResolvedCache = { name: 'remote', method: 'checksum', backend, implicit: false }
    const item = makeWorkItem(scratch, resolved)

    const cacheState = await checkCacheState(item, 'checksum', env)
    expect(cacheState.cached).toBe(false)
    rmSync(scratch, { recursive: true, force: true })
  })

  describe('with restore off (run --no-restore)', () => {
    async function seededBackend(): Promise<{ backend: CacheBackend; stateKey: string }> {
      const scratch = mkdtempSync(join(tmpdir(), 'hammerkit-seed-'))
      const env = environmentMock(scratch)
      const backend = makeBackend()
      const item = makeWorkItem(scratch, { name: 'remote', method: 'checksum', backend, implicit: false })
      const stats = await getWorkCacheStats(item.data, env)
      const stateKey = getStateKey(stats, 'checksum')
      await writeCacheMetadata(env, item, stats, getWorkTaskCacheDescription(item))
      await backend.push(item.id(), stateKey, getCacheDirectory(getWorkInstanceId(item)), env)
      rmSync(scratch, { recursive: true, force: true })
      return { backend, stateKey }
    }

    function spied(backend: CacheBackend) {
      return { ...backend, pull: vi.fn(backend.pull), has: vi.fn(backend.has), touch: vi.fn(backend.touch) }
    }

    function dependent() {
      return { name: 'e2e', status: { write: vi.fn() } } as any
    }

    let scratch: string
    beforeEach(() => {
      scratch = mkdtempSync(join(tmpdir(), 'hammerkit-no-restore-'))
    })
    afterEach(() => {
      rmSync(scratch, { recursive: true, force: true })
    })

    it('reports a hit without pulling, and pulls it once for any number of dependents', async () => {
      const { backend: real, stateKey } = await seededBackend()
      const backend = spied(real)
      const env = environmentMock(scratch)
      const item = makeWorkItem(scratch, { name: 'remote', method: 'checksum', backend, implicit: false })
      const restore = vi.spyOn(item.runtime, 'restore')

      const cacheState = await checkCacheState(item, 'checksum', env, { restore: false })
      expect(cacheState).toMatchObject({ cached: true, stateKey })
      expect(backend.pull).not.toHaveBeenCalled()
      expect(backend.touch).toHaveBeenCalledWith(item.id(), stateKey, env)

      const abort = new AbortController().signal
      await Promise.all([restoreDeferred(dependent(), [item], abort), restoreDeferred(dependent(), [item], abort)])
      expect(backend.pull).toHaveBeenCalledTimes(1)
      expect(restore).toHaveBeenCalledTimes(1)
    })

    it('fails the dependent when the entry is gone by the time it is needed', async () => {
      const { backend: real } = await seededBackend()
      const backend = { ...spied(real), pull: vi.fn(async () => false) }
      const env = environmentMock(scratch)
      const item = makeWorkItem(scratch, { name: 'remote', method: 'checksum', backend, implicit: false })

      expect((await checkCacheState(item, 'checksum', env, { restore: false })).cached).toBe(true)
      await expect(restoreDeferred(dependent(), [item], new AbortController().signal)).rejects.toThrow(
        'demo-task is no longer in cache "remote"'
      )
    })

    it('runs the task when the lookup fails', async () => {
      const backend = {
        ...makeBackend(),
        has: vi.fn(async () => {
          throw new Error('bucket unreachable')
        }),
      }
      const env = environmentMock(scratch)
      const item = makeWorkItem(scratch, { name: 'remote', method: 'checksum', backend, implicit: false })

      expect((await checkCacheState(item, 'checksum', env, { restore: false })).cached).toBe(false)
      expect(item.status.write).toHaveBeenCalledWith('warn', expect.stringContaining('bucket unreachable'))
    })

    it('forgets a deferred hit when the task is checked again', async () => {
      const { backend: real } = await seededBackend()
      const backend = spied(real)
      const env = environmentMock(scratch)
      const item = makeWorkItem(scratch, { name: 'remote', method: 'checksum', backend, implicit: false })

      expect((await checkCacheState(item, 'checksum', env, { restore: false })).cached).toBe(true)
      backend.has.mockResolvedValue(false)
      expect((await checkCacheState(item, 'checksum', env, { restore: false })).cached).toBe(false)
      await restoreDeferred(dependent(), [item], new AbortController().signal)
      expect(backend.pull).not.toHaveBeenCalled()
    })
  })
})
