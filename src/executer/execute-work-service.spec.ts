import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { executeWorkService, stopService } from './execute-work-service'
import { environmentMock } from './environment-mock'
import { State } from './state'
import { ServiceState } from './scheduler/service-state'
import { ProcessManager } from './process-manager'
import { CliExecOptions } from '../cli'
import { TaskState } from './scheduler/task-state'

function makeService(environment: ReturnType<typeof environmentMock>, executeImpl?: (...args: any[]) => Promise<void>) {
  const execute = vi.fn(
    executeImpl ??
      (async (_environment: any, options: any) => {
        options.state.set({
          type: 'running',
          dns: { containerId: 'c1' },
          stateKey: options.stateKey,
          remote: null,
        })
      })
  )
  const stop = vi.fn()
  const work = {
    id: () => 's1',
    name: 'svc',
    status: { write: vi.fn() },
    data: {
      type: 'container-service',
      name: 'svc',
      src: [],
      caching: { name: 'none', method: 'none', backend: {}, implicit: true },
      continuous: false,
    },
    state: new State<ServiceState>({ type: 'pending', stateKey: null }),
    runtime: { execute, stop },
    deps: [],
    needs: [],
    requiredBy: [],
  } as any
  return { work, execute, stop }
}

function makeRequiredBy(name: string, state: TaskState) {
  return {
    id: () => name,
    name,
    status: { write: vi.fn() },
    data: { type: 'local-task' },
    state: new State<TaskState>(state),
    deps: [],
    needs: [],
    requiredBy: [],
  } as any
}

function makeOptions(type: 'execute' | 'up'): CliExecOptions {
  return {
    type,
    watch: false,
    daemon: false,
    cacheDefault: 'none',
    workers: 1,
    logMode: 'live',
    processManager: new ProcessManager(1),
  } as CliExecOptions
}

describe('stopService', () => {
  it('calls runtime.stop when the service is running', async () => {
    const environment = environmentMock(tmpdir())
    const { work, stop } = makeService(environment)
    work.state.set({ type: 'running', dns: { containerId: 'c1' }, stateKey: 'k', remote: null })

    await stopService(work)

    expect(stop).toHaveBeenCalledTimes(1)
  })

  it('does not call runtime.stop for any other state', async () => {
    const environment = environmentMock(tmpdir())
    const { work, stop } = makeService(environment)
    work.state.set({ type: 'pending', stateKey: null })

    await stopService(work)

    expect(stop).not.toHaveBeenCalled()
  })
})

describe('executeWorkService', () => {
  let cwd: string

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'hammerkit-service-'))
  })

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true })
  })

  it("type 'execute' reaches the running state and passes through starting/ready", async () => {
    const environment = environmentMock(cwd)
    const { work, execute } = makeService(environment)
    // in execute mode awaitRequirement races over requiredBy; an empty array
    // would never settle (resetWorkTree drops standalone services), so mirror
    // the real scheduler shape with an already-ready requirement task
    work.requiredBy = [makeRequiredBy('build', { type: 'ready', started: new Date(), stateKey: 'k' })]
    const states: string[] = []
    work.state.on('test-states', (state: ServiceState) => states.push(state.type))

    await executeWorkService(work, environment, makeOptions('execute'))

    expect(execute).toHaveBeenCalledTimes(1)
    expect(work.state.current.type).toBe('running')
    expect(states).toEqual(['starting', 'ready', 'running'])
  })

  it('calls runtime.execute with the cache state, abort signal, state and daemon flag', async () => {
    const environment = environmentMock(cwd)
    const { work, execute } = makeService(environment)
    work.requiredBy = [makeRequiredBy('build', { type: 'ready', started: new Date(), stateKey: 'k' })]

    await executeWorkService(work, environment, makeOptions('execute'))

    expect(execute).toHaveBeenCalledTimes(1)
    const call = execute.mock.calls[0] as any[]
    expect(call[0]).toBe(environment)
    expect(call[1].abort).toBeInstanceOf(AbortSignal)
    expect(call[1].state).toBe(work.state)
    expect(call[1].daemon).toBe(false)
    expect(typeof call[1].cache.stateKey).toBe('string')
  })

  it('marks the service as error when runtime.execute throws', async () => {
    const environment = environmentMock(cwd)
    const { work } = makeService(environment, async () => {
      throw new Error('boom')
    })
    work.requiredBy = [makeRequiredBy('build', { type: 'ready', started: new Date(), stateKey: 'k' })]

    await executeWorkService(work, environment, makeOptions('execute'))

    expect(work.state.current).toEqual({
      type: 'error',
      errorMessage: 'boom',
      stateKey: null,
    })
  })

  it('marks the service as canceled when the environment aborts before execution', async () => {
    const environment = environmentMock(cwd)
    environment.abortCtrl.abort()
    const { work, execute } = makeService(environment)
    work.requiredBy = [makeRequiredBy('build', { type: 'ready', started: new Date(), stateKey: 'k' })]

    await executeWorkService(work, environment, makeOptions('execute'))

    expect(execute).not.toHaveBeenCalled()
    expect(work.state.current).toEqual({ type: 'canceled', stateKey: null })
  })

  it("type 'up' is canceled without awaiting requirements when the environment aborts before execution", async () => {
    const environment = environmentMock(cwd)
    environment.abortCtrl.abort()
    const { work, execute } = makeService(environment)

    await executeWorkService(work, environment, makeOptions('up'))

    expect(execute).not.toHaveBeenCalled()
    expect(work.state.current).toEqual({ type: 'canceled', stateKey: null })
  })

  it("type 'up' reaches the running state without awaiting requirements", async () => {
    const environment = environmentMock(cwd)
    const { work, execute } = makeService(environment)

    await executeWorkService(work, environment, makeOptions('up'))

    expect(execute).toHaveBeenCalledTimes(1)
    expect(work.state.current.type).toBe('running')
  })

  it("type 'up' does not await requiredBy items, so it runs even when a requirement is pending", async () => {
    const environment = environmentMock(cwd)
    const { work } = makeService(environment)
    work.requiredBy = [makeRequiredBy('pending-task', { type: 'pending', stateKey: null })]

    await executeWorkService(work, environment, makeOptions('up'))

    expect(work.state.current.type).toBe('running')
  })

  it("type 'execute' waits for a ready requirement before starting", async () => {
    const environment = environmentMock(cwd)
    const { work } = makeService(environment)
    const requirement = makeRequiredBy('pending-task', { type: 'pending', stateKey: null })
    work.requiredBy = [requirement]

    const pending = executeWorkService(work, environment, makeOptions('execute'))
    const starting = new Promise<void>((resolve) => {
      const handle = work.state.on('wait-ready', (state: ServiceState) => {
        if (state.type === 'starting') {
          handle.close()
          resolve()
        }
      })
    })

    const result = Promise.race([
      starting.then(() => 'started'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 100)),
    ])
    expect(await result).toBe('timeout')

    requirement.state.set({ type: 'ready', started: new Date(), stateKey: 'k' })
    await pending
    expect(work.state.current.type).toBe('running')
  })
})
