// Verifies that the grouped logger only flushes a task/service once it reaches
// a terminal state, by mocking the underlying log helpers and iterators.

vi.mock('../log', () => ({
  writeWorkItemLogToConsole: vi.fn(),
  printWorkTreeResult: vi.fn().mockResolvedValue(undefined),
  getWorkItemMaxLength: vi.fn(() => 10),
}))
vi.mock('../planner/utils/plan-work-tasks', () => ({
  iterateWorkTasks: vi.fn(),
  iterateWorkServices: vi.fn(),
}))

import type { MockedFunction } from 'vitest'
import { groupedLogger } from './grouped-logger'
import { State } from '../executer/state'
import { WorkTree } from '../planner/work-tree'
import { iterateWorkServices, iterateWorkTasks } from '../planner/utils/plan-work-tasks'
import { printWorkTreeResult, writeWorkItemLogToConsole } from '../log'

const mockedIterTasks = iterateWorkTasks as MockedFunction<typeof iterateWorkTasks>
const mockedIterServices = iterateWorkServices as MockedFunction<typeof iterateWorkServices>
const mockedWrite = writeWorkItemLogToConsole as MockedFunction<typeof writeWorkItemLogToConsole>
const mockedPrint = printWorkTreeResult as MockedFunction<typeof printWorkTreeResult>

function fakeTask(name: string, type: string, logs: any[] = []) {
  return { name, state: { current: { type } }, status: { read: () => logs } } as any
}

describe('groupedLogger', () => {
  beforeEach(() => {
    mockedWrite.mockClear()
    mockedPrint.mockClear()
    mockedIterTasks.mockReset()
    mockedIterServices.mockReset()
  })

  it('flushes a task only once it reaches a terminal state and not again on re-emit', () => {
    const t = fakeTask('t1', 'pending', [{ id: 1 }])
    mockedIterTasks.mockImplementation(function* () {
      yield t
    } as any)
    mockedIterServices.mockImplementation(function* () {} as any)

    const state = new State<WorkTree>({ services: {}, tasks: { t1: t } } as any)
    groupedLogger(state, {} as any)

    state.set(state.current) // pending — should NOT flush
    expect(mockedWrite).not.toHaveBeenCalled()

    t.state.current.type = 'completed'
    state.set(state.current) // completed — flush once
    expect(mockedWrite).toHaveBeenCalledTimes(1)

    state.set(state.current) // already-flushed task — must not flush again
    expect(mockedWrite).toHaveBeenCalledTimes(1)
  })

  it.each(['crash', 'error', 'completed'])('flushes on terminal state %s', (terminal) => {
    const t = fakeTask('t1', terminal, [{ id: 1 }])
    mockedIterTasks.mockImplementation(function* () {
      yield t
    } as any)
    mockedIterServices.mockImplementation(function* () {} as any)

    const state = new State<WorkTree>({ services: {}, tasks: { t1: t } } as any)
    groupedLogger(state, {} as any)
    state.set(state.current)
    expect(mockedWrite).toHaveBeenCalledTimes(1)
  })

  it('flushes a service on type "end" and not again', () => {
    const s = fakeTask('svc1', 'starting', [{ id: 1 }])
    mockedIterTasks.mockImplementation(function* () {} as any)
    mockedIterServices.mockImplementation(function* () {
      yield s
    } as any)

    const state = new State<WorkTree>({ services: { svc1: s }, tasks: {} } as any)
    groupedLogger(state, {} as any)

    state.set(state.current) // not yet ended
    expect(mockedWrite).not.toHaveBeenCalled()

    s.state.current.type = 'end'
    state.set(state.current) // ended — flush
    expect(mockedWrite).toHaveBeenCalledTimes(1)

    state.set(state.current) // already flushed — no second call
    expect(mockedWrite).toHaveBeenCalledTimes(1)
  })

  it('complete() delegates to printWorkTreeResult', async () => {
    mockedIterTasks.mockImplementation(function* () {} as any)
    mockedIterServices.mockImplementation(function* () {} as any)
    const state = new State<WorkTree>({ services: {}, tasks: {} } as any)
    const logger = groupedLogger(state, {} as any)
    await logger.complete({ state: state.current, success: true }, {} as any)
    expect(mockedPrint).toHaveBeenCalledTimes(1)
  })
})
