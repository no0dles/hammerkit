import { tmpdir } from 'os'
import { executeWorkTask } from './execute-work-task'
import { environmentMock } from './environment-mock'
import { State } from './state'
import { TaskState } from './scheduler/task-state'
import { ProcessManager } from './process-manager'
import { CliExecOptions } from '../cli'
import { ExecuteOptions } from '../runtime/runtime'

// The cache key is beside the point: the task always runs.
vi.mock('./scheduler/enqueue-next', () => ({
  checkCacheState: async () => ({
    cached: false,
    stateKey: 'k',
    provable: true,
    resolved: { name: 'none', method: 'none', backend: {}, implicit: true },
  }),
}))

const MINUTE = 60_000

// A runtime the test drives: it tells the quota's refusals through the options it hands
// over, and its command ends when the test says so, or stops on an abort, as the Kubernetes
// runtime does.
function controlledRuntime() {
  let start!: (options: ExecuteOptions<TaskState>) => void
  let finish!: () => void
  const started = new Promise<ExecuteOptions<TaskState>>((resolve) => (start = resolve))
  const finished = new Promise<void>((resolve) => (finish = resolve))
  return {
    started,
    finish: () => finish(),
    runtime: {
      async execute(_environment: unknown, options: ExecuteOptions<TaskState>) {
        start(options)
        const aborted = new Promise<void>((resolve) =>
          options.abort.addEventListener('abort', () => resolve(), { once: true })
        )
        await Promise.race([finished, aborted])
        if (options.abort.aborted) {
          options.state.set({ stateKey: options.stateKey, type: 'canceled' })
        }
      },
      stop: vi.fn(),
    },
  }
}

async function run(timeout: number) {
  const control = controlledRuntime()
  const environment = environmentMock(tmpdir())
  const work = {
    id: () => 'image-todo',
    name: 'container:image-todo',
    status: { write: vi.fn(), console: vi.fn() },
    data: { type: 'kubernetes-task', name: 'image-todo', cmds: ['build'], timeout },
    state: new State<TaskState>({ type: 'pending', stateKey: null }),
    runtime: control.runtime,
    deps: [],
    needs: [],
    requiredBy: [],
  } as any
  const done = executeWorkTask(work, environment, {
    type: 'execute',
    watch: false,
    daemon: false,
    cacheDefault: 'none',
    workers: 1,
    logMode: 'live',
    timeout: null,
    maxTimeout: null,
    processManager: new ProcessManager(1),
  } as unknown as CliExecOptions)
  const options = await control.started
  return { work, environment, options, done, finish: control.finish }
}

// A task's `timeout` counts the time it runs, not the time its pod waits for room under the
// quota of the namespace. That wait may last as long as the timeout in all, besides the
// limit of the quota wait itself (QUOTA_TIMEOUT).
describe('task timeout and the quota', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not count the wait for room under the quota', async () => {
    const task = await run(30 * MINUTE)
    task.options.onQuotaRefused?.(true)
    await vi.advanceTimersByTimeAsync(25 * MINUTE)
    task.options.onQuotaRefused?.(false)
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    task.finish()
    await task.done
    expect(task.work.state.current).toMatchObject({ type: 'completed' })
  })

  it('still fails a task that runs longer than its timeout', async () => {
    const task = await run(30 * MINUTE)
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    await task.done
    expect(task.work.state.current).toMatchObject({ type: 'error', errorMessage: 'timed out after 30m' })
  })

  it('fails a task that waited for the quota, then runs longer than its timeout', async () => {
    const task = await run(30 * MINUTE)
    task.options.onQuotaRefused?.(true)
    await vi.advanceTimersByTimeAsync(25 * MINUTE)
    task.options.onQuotaRefused?.(false)
    await vi.advanceTimersByTimeAsync(30 * MINUTE - 1)
    expect(task.work.state.current).toMatchObject({ type: 'running' })
    await vi.advanceTimersByTimeAsync(1)
    await task.done
    expect(task.work.state.current).toMatchObject({ type: 'error', errorMessage: 'timed out after 30m' })
  })

  it('gives up waiting for the quota once it waited as long as its timeout', async () => {
    const task = await run(30 * MINUTE)
    task.options.onQuotaRefused?.(true)
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    await task.done
    expect(task.work.state.current).toMatchObject({
      type: 'error',
      errorMessage: 'gave up waiting for room under the quota of the namespace after 30m, its timeout',
    })
  })

  it('adds up the waits of a pod the quota refuses, admits and refuses again', async () => {
    const task = await run(30 * MINUTE)
    task.options.onQuotaRefused?.(true)
    await vi.advanceTimersByTimeAsync(20 * MINUTE)
    task.options.onQuotaRefused?.(false)
    await vi.advanceTimersByTimeAsync(MINUTE)
    task.options.onQuotaRefused?.(true)
    await vi.advanceTimersByTimeAsync(10 * MINUTE - 1)
    expect(task.work.state.current).toMatchObject({ type: 'running' })
    await vi.advanceTimersByTimeAsync(1)
    await task.done
    expect(task.work.state.current).toMatchObject({
      type: 'error',
      errorMessage: 'gave up waiting for room under the quota of the namespace after 30m, its timeout',
    })
  })

  it('is canceled when the run stops while it waits for the quota', async () => {
    const task = await run(30 * MINUTE)
    task.options.onQuotaRefused?.(true)
    await vi.advanceTimersByTimeAsync(MINUTE)
    task.environment.abortCtrl.abort()
    await task.done
    expect(task.work.state.current).toMatchObject({ type: 'canceled' })
  })
})
