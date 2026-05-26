// interactiveLogger hides the cursor, polls writeWorkTreeStatus on a 100ms
// ticker, and writes on every state change until complete() stops it.

jest.mock('../log', () => ({
  writeWorkTreeStatus: jest.fn(),
  printWorkTreeResult: jest.fn().mockResolvedValue(undefined),
  hideCursor: jest.fn(),
  showCursor: jest.fn(),
}))
jest.mock('readline', () => ({ clearScreenDown: jest.fn() }))

import { interactiveLogger } from './interactive-logger'
import { State } from '../executer/state'
import { WorkTree } from '../planner/work-tree'
import { hideCursor, printWorkTreeResult, showCursor, writeWorkTreeStatus } from '../log'
import { clearScreenDown } from 'readline'

const mockedWriteStatus = writeWorkTreeStatus as jest.MockedFunction<typeof writeWorkTreeStatus>
const mockedHide = hideCursor as jest.MockedFunction<typeof hideCursor>
const mockedShow = showCursor as jest.MockedFunction<typeof showCursor>
const mockedClear = clearScreenDown as jest.MockedFunction<typeof clearScreenDown>
const mockedPrint = printWorkTreeResult as jest.MockedFunction<typeof printWorkTreeResult>

describe('interactiveLogger', () => {
  beforeEach(() => {
    jest.useFakeTimers()
    mockedWriteStatus.mockClear()
    mockedHide.mockClear()
    mockedShow.mockClear()
    mockedClear.mockClear()
    mockedPrint.mockClear()
  })
  afterEach(() => {
    jest.useRealTimers()
  })

  it('hides the cursor, ticks every 100ms, and writes on state changes', async () => {
    const state = new State<WorkTree>({ services: {}, tasks: {} } as any)
    const env = { stdout: { write: jest.fn() } } as any
    const logger = interactiveLogger(state, env)

    // hideCursor on construction; initial tick fired immediately
    expect(mockedHide).toHaveBeenCalledTimes(1)
    expect(mockedWriteStatus).toHaveBeenCalledTimes(1)

    // advance one tick window → one additional writeWorkTreeStatus
    jest.advanceTimersByTime(100)
    expect(mockedWriteStatus).toHaveBeenCalledTimes(2)

    // a state change writes status synchronously
    state.set({ services: {}, tasks: {} } as any)
    expect(mockedWriteStatus).toHaveBeenCalledTimes(3)

    // complete() stops the ticker and restores the cursor
    await logger.complete({ state: state.current, success: true }, env)
    expect(mockedClear).toHaveBeenCalledWith(env.stdout)
    expect(mockedPrint).toHaveBeenCalledTimes(1)
    expect(mockedShow).toHaveBeenCalledTimes(1)

    // after complete, advancing time must NOT schedule further writes
    const after = mockedWriteStatus.mock.calls.length
    jest.advanceTimersByTime(1000)
    expect(mockedWriteStatus.mock.calls.length).toBe(after)
  })
})
