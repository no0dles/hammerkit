import { ConsoleContextMock } from './console-context-mock'

export function getConsoleContextMock(): ConsoleContextMock {
  const expectedLogs: { [key: string]: { fulfilled: boolean } } = {}

  function complete(message: string) {
    const obj = expectedLogs[message]
    if (obj) {
      obj.fulfilled = true
      delete expectedLogs[message]
    }
  }

  return {
    warn(message: string) {
      complete(message)
    },
    info(message: string) {
      complete(message)
    },
    error(message: string) {
      complete(message)
    },
    debug(message: string) {
      complete(message)
    },
    expectLog(message: string): { fulfilled: boolean } {
      expectedLogs[message] = { fulfilled: false }
      return expectedLogs[message]
    },
  }
}
