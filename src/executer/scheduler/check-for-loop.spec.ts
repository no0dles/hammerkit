import { checkForLoop } from './check-for-loop'
import { State } from '../state'
import { TaskState } from '../scheduler/task-state'
import { ServiceState } from '../scheduler/service-state'

function fakeItem(name: string, dataType: string, deps: any[] = [], needs: any[] = []) {
  return {
    id: () => name,
    name,
    status: { write: vi.fn() },
    data: { type: dataType },
    state: new State<TaskState | ServiceState>({ type: 'pending', stateKey: null }),
    deps,
    needs,
    requiredBy: [],
  } as any
}

describe('checkForLoop', () => {
  it('marks a task with a dependency cycle as error', () => {
    const a = fakeItem('a', 'local-task')
    a.deps = [a]

    checkForLoop({ tasks: { a }, services: {}, environment: { type: 'docker' } } as any)

    expect(a.state.current.type).toBe('error')
    const error = a.state.current as TaskState & { errorMessage: string }
    expect(error.errorMessage).toContain('task cycle detected')
    expect(error.errorMessage).toContain('a')
  })

  it('marks a service with a needs cycle as error', () => {
    const b = fakeItem('b', 'container-service')
    b.needs = [{ name: 'b', service: b }]

    checkForLoop({ tasks: {}, services: { b }, environment: { type: 'docker' } } as any)

    expect(b.state.current.type).toBe('error')
    const error = b.state.current as ServiceState & { errorMessage: string }
    expect(error.errorMessage).toContain('service cycle detected')
    expect(error.errorMessage).toContain('b')
  })

  it('marks both ends of a mixed deps/needs cycle as error', () => {
    const a = fakeItem('a', 'local-task')
    const s = fakeItem('s', 'container-service')
    a.deps = [s]
    s.needs = [{ name: 'a', service: a }]

    checkForLoop({ tasks: { a }, services: { s }, environment: { type: 'docker' } } as any)

    expect(a.state.current.type).toBe('error')
    expect(s.state.current.type).toBe('error')
    // the task loop reports the task cycle across deps/needs
    expect((a.state.current as any).errorMessage).toContain('task cycle detected')
    // the service loop reports the cycle on the needs edge
    expect((s.state.current as any).errorMessage).toContain('service cycle detected')
  })

  it('leaves acyclic work trees pending', () => {
    const a = fakeItem('a', 'local-task')
    const s = fakeItem('s', 'container-service')
    a.deps = []
    a.needs = [{ name: 's', service: s }]
    s.requiredBy = []

    checkForLoop({ tasks: { a }, services: { s }, environment: { type: 'docker' } } as any)

    expect(a.state.current).toEqual({ type: 'pending', stateKey: null })
    expect(s.state.current).toEqual({ type: 'pending', stateKey: null })
  })

  it('does not report a diamond-shaped dependency graph as a cycle', () => {
    const t1 = fakeItem('t1', 'local-task')
    const t2 = fakeItem('t2', 'local-task')
    const t3 = fakeItem('t3', 'local-task')
    t1.deps = [t2, t3]
    t2.deps = []
    t3.deps = []

    checkForLoop({ tasks: { t1, t2, t3 }, services: {}, environment: { type: 'docker' } } as any)

    expect(t1.state.current).toEqual({ type: 'pending', stateKey: null })
    expect(t2.state.current).toEqual({ type: 'pending', stateKey: null })
    expect(t3.state.current).toEqual({ type: 'pending', stateKey: null })
  })
})
