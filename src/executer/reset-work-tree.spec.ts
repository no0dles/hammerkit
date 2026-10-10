import { resetWorkTree } from './reset-work-tree'
import { State } from './state'
import { TaskState } from './scheduler/task-state'
import { ServiceState } from './scheduler/service-state'

function fakeTask(name: string, state: TaskState) {
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

function fakeService(name: string, state: ServiceState, requiredBy: any[] = []) {
  return {
    id: () => name,
    name,
    status: { write: vi.fn() },
    data: { type: 'container-service' },
    state: new State<ServiceState>(state),
    deps: [],
    needs: [],
    requiredBy,
  } as any
}

describe('resetWorkTree', () => {
  it("type 'up' resets all tasks and keeps and resets all services", () => {
    const t1 = fakeTask('t1', { type: 'completed', duration: 1, cached: false, stateKey: 'k' })
    const s1 = fakeService('s1', { type: 'running', dns: { containerId: 'c1' }, stateKey: 'k', remote: null })
    const s2 = fakeService('s2', { type: 'error', stateKey: null, errorMessage: 'x' })
    const environment = { type: 'docker' }

    const result = resetWorkTree({ tasks: { t1 }, services: { s1, s2 }, environment } as any, 'up')

    expect(Object.keys(result.tasks)).toEqual(['t1'])
    expect(result.tasks['t1'].state.current).toEqual({ type: 'pending', stateKey: null })
    expect(Object.keys(result.services)).toEqual(['s1', 's2'])
    expect(result.services['s1'].state.current).toEqual({ type: 'pending', stateKey: null })
    expect(result.services['s2'].state.current).toEqual({ type: 'pending', stateKey: null })
    expect(result.environment).toBe(environment)
  })

  it("type 'execute' drops standalone services (empty requiredBy) without touching their state", () => {
    const s1State = new State<ServiceState>({
      type: 'running',
      dns: { containerId: 'c1' },
      stateKey: 'k',
      remote: null,
    })
    const s1 = {
      id: () => 's1',
      name: 's1',
      status: { write: vi.fn() },
      data: { type: 'container-service' },
      state: s1State,
      deps: [],
      needs: [],
      requiredBy: [],
    } as any
    const s2 = fakeService('s2', { type: 'error', stateKey: null, errorMessage: 'x' }, [
      fakeTask('t1', { type: 'pending', stateKey: null }),
    ])
    const t1 = fakeTask('t1', { type: 'completed', duration: 1, cached: false, stateKey: 'k' })
    const environment = { type: 'docker' }

    const result = resetWorkTree({ tasks: { t1 }, services: { s1, s2 }, environment } as any, 'execute')

    // standalone service is dropped entirely
    expect(result.services['s1']).toBeUndefined()
    expect(Object.keys(result.services)).toEqual(['s2'])
    // its state object is untouched (still the original State instance and value)
    expect(s1.state).toBe(s1State)
    expect(s1State.current.type).toBe('running')

    // referenced service is kept and reset
    expect(result.services['s2'].state.current).toEqual({ type: 'pending', stateKey: null })
    // tasks are always kept and reset
    expect(result.tasks['t1'].state.current).toEqual({ type: 'pending', stateKey: null })
    expect(result.environment).toBe(environment)
  })

  it("type 'execute' resets tasks by replacing the state on the original item", () => {
    const originalState = new State<TaskState>({ type: 'completed', duration: 1, cached: false, stateKey: 'k' })
    const t1 = {
      id: () => 't1',
      name: 't1',
      status: { write: vi.fn() },
      data: { type: 'local-task' },
      state: originalState,
      deps: [],
      needs: [],
      requiredBy: [],
    } as any

    const result = resetWorkTree({ tasks: { t1 }, services: {}, environment: { type: 'docker' } } as any, 'execute')

    // the original item object is mutated: task.state is replaced in place
    expect(result.tasks['t1']).toBe(t1)
    expect(t1.state).not.toBe(originalState)
    expect(t1.state.current).toEqual({ type: 'pending', stateKey: null })
    expect(result.environment).toEqual({ type: 'docker' })
  })

  it('type down keeps standalone services and resets them', () => {
    const s1 = fakeService('s1', { type: 'running', dns: { containerId: 'c1' }, stateKey: 'k', remote: null })

    const result = resetWorkTree({ tasks: {}, services: { s1 }, environment: { type: 'docker' } } as any, 'down')

    expect(result.services['s1'].state.current).toEqual({ type: 'pending', stateKey: null })
  })
})
