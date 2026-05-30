import { join } from 'path'
import { tmpdir } from 'os'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { getLocalWorkRuntime } from './work-runtime-local'
import { WorkItem } from './work-item'
import { LocalWorkTask } from './work-task'
import { environmentMock } from '../executer/environment-mock'
import { State } from '../executer/state'
import { TaskState } from '../executer/scheduler/task-state'

const mockFindProcess = jest.fn()
jest.mock('find-process', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockFindProcess(...args),
}))

jest.mock('../executer/local-task', () => ({
  localTask: jest.fn().mockResolvedValue(undefined),
}))

function makeTask(cwd: string): WorkItem<LocalWorkTask> {
  return {
    id: () => 'task-1',
    name: 'task-1',
    status: { write: jest.fn() } as any,
    data: {
      type: 'local-task',
      name: 'task-1',
      cwd,
      cmds: [],
      generates: [],
      src: [],
      envs: { variables: {}, processEnvs: {} } as any,
      labels: {},
      shell: '/bin/sh',
      continuous: false,
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
    })

    expect(await env.file.exists(join(cwd, '.hammerkit', 'task-1.pid'))).toBe(false)
    expect(await env.file.exists(join(cwd, '.hammerkit', 'task-1'))).toBe(true)
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
    })

    expect(state.current.type).not.toBe('error')
    expect(mockFindProcess).not.toHaveBeenCalled()
  })
})
