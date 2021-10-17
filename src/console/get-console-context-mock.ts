import { ConsoleContextMock, ConsoleContextMockListener } from './console-context-mock'

export function getConsoleContextMock(): ConsoleContextMock {
  const expectedLogs: { [key: string]: { fulfilled: boolean } } = {}
  const listeners: ConsoleContextMockListener[] = []

  function complete(type: string, message: string) {
    for (const listener of listeners) {
      listener(type, message)
    }
    const obj = expectedLogs[message]
    if (obj) {
      obj.fulfilled = true
      delete expectedLogs[message]
    }
  }

  return {
    warn(message: string) {
      complete('warn', message)
    },
    info(message: string) {
      complete('info', message)
    },
    error(message: string) {
      complete('error', message)
    },
    debug(message: string) {
      complete('debug', message)
    },
    on(listener: ConsoleContextMockListener) {
      listeners.push(listener)
    },
    expectLog(message: string): { fulfilled: boolean } {
      expectedLogs[message] = { fulfilled: false }
      return expectedLogs[message]
    },
  }
}
