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

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// A runtime whose pod first waits for room under the quota for `refusedMs`, then runs for
// `runsMs`; on an abort it stops, as the Kubernetes runtime does.
function runtime(refusedMs: number, runsMs: number) {
  return {
    async execute(_environment: unknown, options: ExecuteOptions<TaskState>) {
      if (refusedMs > 0) {
        options.onQuotaRefused?.(true)
        await wait(refusedMs)
        options.onQuotaRefused?.(false)
      }
      const until = Date.now() + runsMs
      while (Date.now() < until) {
        if (options.abort.aborted) {
          options.state.set({ stateKey: options.stateKey, type: 'canceled' })
          return
        }
        await wait(10)
      }
    },
    stop: vi.fn(),
  }
}

function task(timeout: number, refusedMs: number, runsMs: number) {
  return {
    id: () => 'image-todo',
    name: 'container:image-todo',
    status: { write: vi.fn(), console: vi.fn() },
    data: { type: 'kubernetes-task', name: 'image-todo', cmds: ['build'], timeout },
    state: new State<TaskState>({ type: 'pending', stateKey: null }),
    runtime: runtime(refusedMs, runsMs),
    deps: [],
    needs: [],
    requiredBy: [],
  } as any
}

function options(): CliExecOptions {
  return {
    type: 'execute',
    watch: false,
    daemon: false,
    cacheDefault: 'none',
    workers: 1,
    logMode: 'live',
    timeout: null,
    maxTimeout: null,
    processManager: new ProcessManager(1),
  } as unknown as CliExecOptions
}

// A task's `timeout` counts the time it runs, not the time its pod waits for room under the
// quota of the namespace: that wait has its own limit (QUOTA_TIMEOUT).
describe('task timeout and the quota', () => {
  it('does not count the wait for room under the quota', async () => {
    const work = task(300, 600, 100)
    await executeWorkTask(work, environmentMock(tmpdir()), options())
    expect(work.state.current).toMatchObject({ type: 'completed' })
  })

  it('still fails a task that runs longer than its timeout', async () => {
    const work = task(300, 0, 2000)
    await executeWorkTask(work, environmentMock(tmpdir()), options())
    expect(work.state.current).toMatchObject({ type: 'error', errorMessage: 'timed out after 300ms' })
  })

  it('fails a task that waited for the quota, then runs longer than its timeout', async () => {
    const work = task(300, 600, 2000)
    const started = Date.now()
    await executeWorkTask(work, environmentMock(tmpdir()), options())
    expect(work.state.current).toMatchObject({ type: 'error', errorMessage: 'timed out after 300ms' })
    expect(Date.now() - started).toBeGreaterThanOrEqual(900)
  })
})
