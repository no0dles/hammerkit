import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync } from 'fs'
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
import { getWorkCacheStats, getStateKey } from '../optimizer/get-work-cache-stats'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'

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
    const storedStateKey: string | null = null
    return {
      id: () => 'demo-task',
      name: 'demo-task',
      status: { write: jest.fn() } as any,
      data: {
        type: 'local-task',
        name: 'demo-task',
        cwd,
        cmds: [],
        generates: [],
        src: [],
        envs: { variables: {}, replacements: [] } as any,
        labels: {},
        shell: '/bin/sh',
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

    await writeCacheMetadata(envA, itemA.id(), stats, getWorkTaskCacheDescription(itemA.data))
    const cacheDir = getCacheDirectory(itemA.id())
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
})
