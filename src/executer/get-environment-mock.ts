import { getFileContextMock } from '../file/get-file-context-mock'
import { getConsoleContextMock } from '../console/get-console-context-mock'
import { Defer } from '../utils/defer'
import { EnvironmentMock } from './environment-mock'

export function getEnvironmentMock(): EnvironmentMock {
  return {
    cwd: '/home/user',
    file: getFileContextMock(),
    console: getConsoleContextMock(),
    cancelDefer: new Defer<void>(),
    processEnvs: {},
  }
}
