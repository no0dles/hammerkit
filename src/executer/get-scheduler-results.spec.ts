import { State } from './state'
import { TaskState } from './scheduler/task-state'
import { ServiceState } from './scheduler/service-state'
import { getSchedulerUpResult } from './get-scheduler-up-result'
import { getSchedulerDownResult } from './get-scheduler-down-result'
import { getSchedulerExecuteResult } from './get-scheduler-execute-result'

function makeTree(services: { [id: string]: any }, tasks: { [id: string]: any } = {}) {
  return {
    tasks: Object.fromEntries(Object.entries(tasks).map(([id, s]) => [id, { state: new State(s) }])),
    services: Object.fromEntries(Object.entries(services).map(([id, s]) => [id, { state: new State(s) }])),
    environment: {},
  } as any
}

describe('getSchedulerUpResult', () => {
  it('succeeds when every service is running', () => {
    const tree = makeTree({ a: { type: 'running' } as ServiceState, b: { type: 'running' } as ServiceState })
    expect(getSchedulerUpResult(tree).success).toBe(true)
  })

  it('fails when a service is not running', () => {
    const tree = makeTree({ a: { type: 'running' } as ServiceState, b: { type: 'starting' } as ServiceState })
    expect(getSchedulerUpResult(tree).success).toBe(false)
  })

  it('succeeds when there are no services', () => {
    expect(getSchedulerUpResult(makeTree({})).success).toBe(true)
  })
})

describe('getSchedulerDownResult', () => {
  it('succeeds when no service is running or starting', () => {
    const tree = makeTree({
      a: { type: 'stopping' } as unknown as ServiceState,
      b: { type: 'waiting' } as unknown as ServiceState,
    })
    expect(getSchedulerDownResult(tree).success).toBe(true)
  })

  it('fails when a service is running', () => {
    expect(getSchedulerDownResult(makeTree({ a: { type: 'running' } as ServiceState })).success).toBe(false)
  })

  it('fails when a service is starting', () => {
    expect(getSchedulerDownResult(makeTree({ a: { type: 'starting' } as ServiceState })).success).toBe(false)
  })

  it('succeeds when there are no services', () => {
    expect(getSchedulerDownResult(makeTree({})).success).toBe(true)
  })
})

describe('getSchedulerExecuteResult', () => {
  it('succeeds when all tasks are completed and no service is canceled', () => {
    const tree = makeTree({ s: { type: 'running' } as ServiceState }, { t: { type: 'completed' } as TaskState })
    expect(getSchedulerExecuteResult(tree).success).toBe(true)
  })

  it('fails when a task is in error', () => {
    const tree = makeTree({}, { t: { type: 'error' } as TaskState })
    expect(getSchedulerExecuteResult(tree).success).toBe(false)
  })

  it('fails when a service is canceled', () => {
    const tree = makeTree({ s: { type: 'canceled' } as ServiceState }, { t: { type: 'completed' } as TaskState })
    expect(getSchedulerExecuteResult(tree).success).toBe(false)
  })
})
