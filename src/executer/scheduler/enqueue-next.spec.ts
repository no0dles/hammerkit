import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { environmentMock } from '../environment-mock'
import { checkCacheState, UNCACHED_STATE_KEY } from './enqueue-next'
import { createLocalCacheBackend } from '../../cache/backends/local-cache-backend'
import { State } from '../state'
import { TaskState } from './task-state'
import { WorkItemState } from '../../planner/work-item'
import { LocalWorkTask } from '../../planner/work-task'
import { ResolvedCache } from '../../cache/resolve-cache'
import { CacheMethod } from '../../parser/cache-method'

describe('checkCacheState', () => {
  let scratch: string
  let remoteDir: string
  let machineHome: string
  let originalHome: string | undefined

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), 'hammerkit-enqueue-'))
    remoteDir = mkdtempSync(join(tmpdir(), 'hammerkit-remote-'))
    machineHome = mkdtempSync(join(tmpdir(), 'hammerkit-home-'))
    originalHome = process.env.HOME
    if (process.platform === 'win32') {
      process.env.APPDATA = machineHome
    } else {
      process.env.HOME = machineHome
    }
  })

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true })
    rmSync(remoteDir, { recursive: true, force: true })
    rmSync(machineHome, { recursive: true, force: true })
    if (originalHome !== undefined) {
      process.env.HOME = originalHome
    } else {
      delete process.env.HOME
    }
  })

  // empty remote → backend.pull always misses, so a key mismatch yields cached:false
  function makeResolved(method: CacheMethod): ResolvedCache {
    return {
      name: 'remote',
      method,
      backend: createLocalCacheBackend({ type: 'local', path: remoteDir }),
      implicit: false,
    }
  }

  function makeTask(
    id: string,
    options: {
      resolved: ResolvedCache
      srcFiles?: string[]
      deps?: WorkItemState<LocalWorkTask, TaskState>[]
      storedStateKey?: string | null
    }
  ): WorkItemState<LocalWorkTask, TaskState> {
    const storedStateKey = options.storedStateKey ?? null
    return {
      id: () => id,
      name: id,
      status: { write: vi.fn() } as any,
      data: {
        type: 'local-task',
        name: id,
        cwd: scratch,
        cmds: [],
        generates: [],
        src: (options.srcFiles ?? []).map((absolutePath) => ({
          absolutePath,
          source: absolutePath,
          matcher: () => true,
          inherited: null,
          isFile: true,
        })),
        envs: { variables: {}, replacements: [] } as any,
        labels: {},
        shell: '/bin/sh',
        caching: options.resolved,
        description: null,
        scope: {} as any,
      } as any,
      needs: [],
      deps: options.deps ?? [],
      requiredBy: [],
      state: new State<TaskState>({ type: 'pending', stateKey: null }),
      runtime: {
        async initialize() {},
        async remove() {},
        async execute() {},
        async stop() {},
        async archive() {},
        async restore() {},
        async currentStateKey() {
          return storedStateKey
        },
      } as any,
    }
  }

  it('reports cached:false when caching method is none', async () => {
    const env = environmentMock(scratch)
    const task = makeTask('none-task', { resolved: makeResolved('none') })
    const result = await checkCacheState(task, 'checksum', env)
    expect(result.cached).toBe(false)
  })

  it('reads no source of a task whose cache is off, unless watch mode needs its key', async () => {
    const env = environmentMock(scratch)
    const src = join(scratch, 'big.txt')
    writeFileSync(src, 'v1')
    const task = makeTask('shell', { resolved: makeResolved('none'), srcFiles: [src] })
    const matcher = vi.fn(() => true)
    task.data.src[0].matcher = matcher

    const result = await checkCacheState(task, 'checksum', env)
    expect(result).toMatchObject({ cached: false, stateKey: UNCACHED_STATE_KEY })
    expect(matcher).not.toHaveBeenCalled()

    // a run with the cache on never takes outputs recorded under that key
    const cachedRun = makeTask('shell', {
      resolved: makeResolved('checksum'),
      srcFiles: [src],
      storedStateKey: UNCACHED_STATE_KEY,
    })
    expect((await checkCacheState(cachedRun, 'checksum', env)).cached).toBe(false)

    const watched = await checkCacheState(task, 'checksum', env, { watch: true })
    expect(matcher).toHaveBeenCalled()
    expect(watched.stateKey).not.toBe(UNCACHED_STATE_KEY)
    // with a key, it still never comes from the cache
    const stored = makeTask('shell', {
      resolved: makeResolved('none'),
      srcFiles: [src],
      storedStateKey: watched.stateKey,
    })
    expect((await checkCacheState(stored, 'checksum', env, { watch: true })).cached).toBe(false)
  })

  it('still hashes the sources of a task whose cache is off for a task depending on it', async () => {
    const env = environmentMock(scratch)
    const upstreamSrc = join(scratch, 'upstream.txt')
    writeFileSync(upstreamSrc, 'v1')
    const dependent = () =>
      makeTask('dependent', {
        resolved: makeResolved('checksum'),
        srcFiles: [join(scratch, 'upstream.txt')],
        deps: [makeTask('upstream', { resolved: makeResolved('none'), srcFiles: [upstreamSrc] })],
      })
    const before = (await checkCacheState(dependent(), 'checksum', env)).stateKey
    writeFileSync(upstreamSrc, 'v2')
    expect((await checkCacheState(dependent(), 'checksum', env)).stateKey).not.toBe(before)
  })

  it('reports cached:true when the stored key matches the effective key', async () => {
    const env = environmentMock(scratch)
    const src = join(scratch, 'hit.txt')
    writeFileSync(src, 'v1')
    const probe = makeTask('hit-task', { resolved: makeResolved('checksum'), srcFiles: [src] })
    const { stateKey } = await checkCacheState(probe, 'checksum', env)

    const task = makeTask('hit-task', { resolved: makeResolved('checksum'), srcFiles: [src], storedStateKey: stateKey })
    const result = await checkCacheState(task, 'checksum', env)
    expect(result.cached).toBe(true)
    expect(result.stateKey).toBe(stateKey)
  })

  it('invalidates a downstream task when an upstream dependency source changes', async () => {
    const env = environmentMock(scratch)
    const upstreamSrc = join(scratch, 'upstream.txt')
    writeFileSync(upstreamSrc, 'v1')

    const makeUpstream = () => makeTask('upstream', { resolved: makeResolved('checksum'), srcFiles: [upstreamSrc] })
    const downstreamSrc = join(scratch, 'downstream.txt')
    writeFileSync(downstreamSrc, 'unchanged')
    const makeDownstream = (storedStateKey: string | null) =>
      makeTask('downstream', {
        resolved: makeResolved('checksum'),
        srcFiles: [downstreamSrc],
        deps: [makeUpstream()],
        storedStateKey,
      })

    // First pass: capture the downstream effective key and pretend it was stored.
    const keyBefore = (await checkCacheState(makeDownstream(null), 'checksum', env)).stateKey
    const cachedHit = await checkCacheState(makeDownstream(keyBefore), 'checksum', env)
    expect(cachedHit.cached).toBe(true)

    // Change ONLY the upstream source — downstream's own sources are untouched.
    writeFileSync(upstreamSrc, 'v2-changed')

    const afterChange = await checkCacheState(makeDownstream(keyBefore), 'checksum', env)
    expect(afterChange.stateKey).not.toBe(keyBefore)
    expect(afterChange.cached).toBe(false)
  })

  it('never reports a task without src as cached, nor its dependents', async () => {
    const env = environmentMock(scratch)
    const src = join(scratch, 'dependent.txt')
    writeFileSync(src, 'v1')
    const noSrc = makeTask('no-src', { resolved: makeResolved('checksum') })
    const { stateKey } = await checkCacheState(noSrc, 'checksum', env)
    const stored = makeTask('no-src', { resolved: makeResolved('checksum'), storedStateKey: stateKey })
    expect((await checkCacheState(stored, 'checksum', env)).cached).toBe(false)

    const dependent = makeTask('dependent', { resolved: makeResolved('checksum'), srcFiles: [src], deps: [noSrc] })
    const dependentKey = (await checkCacheState(dependent, 'checksum', env)).stateKey
    const storedDependent = makeTask('dependent', {
      resolved: makeResolved('checksum'),
      srcFiles: [src],
      deps: [noSrc],
      storedStateKey: dependentKey,
    })
    expect((await checkCacheState(storedDependent, 'checksum', env)).cached).toBe(false)
  })

  it('produces a stable key regardless of dependency declaration order', async () => {
    const env = environmentMock(scratch)
    const aSrc = join(scratch, 'a.txt')
    const bSrc = join(scratch, 'b.txt')
    writeFileSync(aSrc, 'a')
    writeFileSync(bSrc, 'b')

    const depA = () => makeTask('dep-a', { resolved: makeResolved('checksum'), srcFiles: [aSrc] })
    const depB = () => makeTask('dep-b', { resolved: makeResolved('checksum'), srcFiles: [bSrc] })

    const forward = makeTask('root', { resolved: makeResolved('checksum'), deps: [depA(), depB()] })
    const reversed = makeTask('root', { resolved: makeResolved('checksum'), deps: [depB(), depA()] })

    const keyForward = (await checkCacheState(forward, 'checksum', env)).stateKey
    const keyReversed = (await checkCacheState(reversed, 'checksum', env)).stateKey
    expect(keyForward).toBe(keyReversed)
  })

  it('restores what the cache has for the key, and tells the runtime the key', async () => {
    const env = environmentMock(scratch)
    const src = join(scratch, 'input.txt')
    writeFileSync(src, 'v1')
    const pull = vi.fn(async () => true)
    const task = makeTask('pulled', {
      resolved: { ...makeResolved('checksum'), backend: { ...makeResolved('checksum').backend, pull } },
      srcFiles: [src],
    })
    const restore = vi.fn(async () => undefined)
    task.runtime.restore = restore
    Object.assign(task.data, { secrets: [], projectRoot: scratch })

    const result = await checkCacheState(task, 'checksum', env)
    expect((task.status.write as any).mock.calls).toEqual([['info', 'pulled pulled from cache "remote" (local)']])
    expect(result.cached).toBe(true)
    expect(pull).toHaveBeenCalledWith('pulled', result.stateKey, expect.any(String), env)
    // a runtime that keeps outputs between runs records which state they are of
    expect(restore).toHaveBeenCalledWith(env, expect.any(String), result.stateKey)
  })
})
