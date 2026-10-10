import {
  awaitCompletedDependencies,
  awaitNoRequirements,
  awaitRequirement,
  awaitRunningNeeds,
} from './await-completed-dependencies'
import { State } from './state'
import { TaskState } from './scheduler/task-state'
import { ServiceState } from './scheduler/service-state'
import { AbortError } from './abort'

function fakeItem(name: string, state: TaskState | ServiceState, dataType = 'local-task') {
  return {
    name,
    status: { write: vi.fn() },
    state: new State<TaskState | ServiceState>(state),
    data: { type: dataType },
    deps: [],
    needs: [],
    requiredBy: [],
  } as any
}

describe('awaitCompletedDependencies', () => {
  it('resolves immediately when a dependency task is already completed', async () => {
    const work = fakeItem('work', { type: 'pending', stateKey: null })
    const dep = fakeItem('dep', { type: 'completed', duration: 1, cached: false, stateKey: 'k' })

    await awaitCompletedDependencies(work, [dep], new AbortController().signal)
  })

  it('resolves when a dependency task transitions to completed', async () => {
    const work = fakeItem('work', { type: 'pending', stateKey: null })
    const dep = fakeItem('dep', { type: 'running', started: new Date(), stateKey: 'k' })

    setTimeout(() => dep.state.set({ type: 'completed', duration: 2, cached: false, stateKey: 'k' }), 5)

    await awaitCompletedDependencies(work, [dep], new AbortController().signal)
    expect(dep.state.current.type).toBe('completed')
  })

  it('rejects with an AbortError when the abort signal fires first', async () => {
    const work = fakeItem('work', { type: 'pending', stateKey: null })
    const dep = fakeItem('dep', { type: 'pending', stateKey: null })
    const ctrl = new AbortController()
    ctrl.abort()

    const result = awaitCompletedDependencies(work, [dep], ctrl.signal)
    await expect(result).rejects.toBeInstanceOf(AbortError)
  })
})

describe('awaitRunningNeeds', () => {
  it('resolves when need services are already running', async () => {
    const work = fakeItem('work', { type: 'pending', stateKey: null })
    const need = fakeItem(
      'db',
      { type: 'running', dns: { containerId: 'c1' }, stateKey: 'k', remote: null },
      'container-service'
    )

    await awaitRunningNeeds(work, [need], new AbortController().signal)
    expect(need.state.current.type).toBe('running')
  })

  it('resolves when a need service transitions to running', async () => {
    const work = fakeItem('work', { type: 'pending', stateKey: null })
    const need = fakeItem('db', { type: 'pending', stateKey: null }, 'container-service')

    setTimeout(() => need.state.set({ type: 'running', dns: { containerId: 'c1' }, stateKey: 'k', remote: null }), 5)

    await awaitRunningNeeds(work, [need], new AbortController().signal)
    expect(need.state.current.type).toBe('running')
  })
})

describe('awaitRequirement', () => {
  it('resolves when a requiredBy task is already ready', async () => {
    const svc = fakeItem('svc', { type: 'pending', stateKey: null }, 'container-service')
    svc.requiredBy = [fakeItem('build', { type: 'ready', started: new Date(), stateKey: 'k' })]

    await awaitRequirement(svc, new AbortController().signal)
  })

  it('resolves when a requiredBy task transitions to ready', async () => {
    const svc = fakeItem('svc', { type: 'pending', stateKey: null }, 'container-service')
    const requiredTask = fakeItem('build', { type: 'pending', stateKey: null })
    svc.requiredBy = [requiredTask]

    setTimeout(() => requiredTask.state.set({ type: 'ready', started: new Date(), stateKey: 'k' }), 5)

    await awaitRequirement(svc, new AbortController().signal)
  })

  it('rejects with an AbortError when the abort signal fires first', async () => {
    const svc = fakeItem('svc', { type: 'pending', stateKey: null }, 'container-service')
    svc.requiredBy = [fakeItem('build', { type: 'pending', stateKey: null })]
    const ctrl = new AbortController()
    ctrl.abort()

    await expect(awaitRequirement(svc, ctrl.signal)).rejects.toBeInstanceOf(AbortError)
  })
})

describe('awaitNoRequirements', () => {
  it('resolves when requiredBy task states are completed, crashed, errored or canceled', async () => {
    const svc = fakeItem('svc', { type: 'pending', stateKey: null }, 'container-service')
    svc.requiredBy = [
      fakeItem('t1', { type: 'completed', duration: 1, cached: false, stateKey: 'k' }),
      fakeItem('t2', { type: 'crash', exitCode: 1, stateKey: 'k' }),
      fakeItem('t3', { type: 'error', errorMessage: 'x', stateKey: null }),
      fakeItem('t4', { type: 'canceled', stateKey: null }),
    ]

    await awaitNoRequirements(svc, new AbortController().signal)
  })

  it('resolves when requiredBy service items are ended, errored or canceled', async () => {
    const svc = fakeItem('svc', { type: 'pending', stateKey: null }, 'container-service')
    svc.requiredBy = [
      fakeItem('s1', { type: 'end', reason: 'terminated', stateKey: null }, 'container-service'),
      fakeItem('s2', { type: 'error', stateKey: null, errorMessage: 'x' }, 'container-service'),
      fakeItem('s3', { type: 'canceled', stateKey: null }, 'container-service'),
    ]

    await awaitNoRequirements(svc, new AbortController().signal)
  })
})
