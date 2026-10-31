import { tmpdir } from 'os'
import { executeWorkService } from './execute-work-service'
import { environmentMock } from './environment-mock'
import { State } from './state'
import { ServiceState } from './scheduler/service-state'
import { TaskState } from './scheduler/task-state'
import { ProcessManager } from './process-manager'
import { CliExecOptions } from '../cli'
import { deferRestore } from './deferred-restore'

// The service's own cache key is beside the point here: this is about what it
// does with its dependencies once it is about to start.
vi.mock('./scheduler/enqueue-next', () => ({
  checkCacheState: async () => ({
    cached: false,
    stateKey: 'k',
    provable: true,
    resolved: { name: 'none', method: 'none', backend: {}, implicit: true },
  }),
}))

function item(name: string, state: TaskState) {
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

// run --no-restore: a dependency that was a hit is only looked up, and a
// service that starts restores its outputs first
describe('a service depending on a hit that was not restored', () => {
  it('restores the hit before it starts', async () => {
    const environment = environmentMock(tmpdir())
    const order: string[] = []
    const execute = vi.fn(async (_environment: any, options: any) => {
      order.push('execute')
      options.state.set({ type: 'running', dns: { containerId: 'c1' }, stateKey: options.stateKey, remote: null })
    })
    const build = item('build', { type: 'completed', cached: true, stateKey: 'k', duration: 0 })
    const restore = vi.fn(async () => {
      order.push('restore')
    })
    deferRestore(build, restore)
    const work = {
      id: () => 'svc',
      name: 'svc',
      status: { write: vi.fn() },
      data: { type: 'container-service', name: 'svc', continuous: false },
      state: new State<ServiceState>({ type: 'pending', stateKey: null }),
      runtime: { execute, stop: vi.fn() },
      deps: [build],
      needs: [],
      requiredBy: [item('e2e', { type: 'ready', started: new Date(), stateKey: 'k' })],
    } as any

    await executeWorkService(work, environment, {
      type: 'execute',
      watch: false,
      daemon: false,
      cacheDefault: 'none',
      workers: 1,
      logMode: 'live',
      processManager: new ProcessManager(1),
    } as CliExecOptions)

    expect(order).toEqual(['restore', 'execute'])
  })
})
