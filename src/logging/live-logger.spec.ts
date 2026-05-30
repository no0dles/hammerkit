// liveLogger forwards every status message verbatim to writeWorkItemLogToConsole.

vi.mock('../log', () => ({
  writeWorkItemLogToConsole: vi.fn(),
  printWorkTreeResult: vi.fn().mockResolvedValue(undefined),
  getWorkItemMaxLength: vi.fn(() => 10),
}))

import type { MockedFunction } from 'vitest'
import { liveLogger } from './live-logger'
import { State } from '../executer/state'
import { WorkTree } from '../planner/work-tree'
import { printWorkTreeResult, writeWorkItemLogToConsole } from '../log'
import { emitter } from '../utils/emitter'

const mockedWrite = writeWorkItemLogToConsole as MockedFunction<typeof writeWorkItemLogToConsole>
const mockedPrint = printWorkTreeResult as MockedFunction<typeof printWorkTreeResult>

describe('liveLogger', () => {
  beforeEach(() => {
    mockedWrite.mockClear()
    mockedPrint.mockClear()
  })

  it('forwards each status message to writeWorkItemLogToConsole', () => {
    const status = emitter<any>()
    const env = { status } as any
    const state = new State<WorkTree>({ services: {}, tasks: {} } as any)
    liveLogger(state, env)

    const msg = { type: 'status' as const, message: 'hi' }
    status.emit(msg)
    expect(mockedWrite).toHaveBeenCalledWith(env, msg, 10)
  })

  it('complete() delegates to printWorkTreeResult', async () => {
    const status = emitter<any>()
    const state = new State<WorkTree>({ services: {}, tasks: {} } as any)
    const logger = liveLogger(state, { status } as any)
    await logger.complete({ state: state.current, success: true }, {} as any)
    expect(mockedPrint).toHaveBeenCalledTimes(1)
  })
})
