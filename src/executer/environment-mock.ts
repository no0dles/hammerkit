import { Environment } from './environment'
import { FileContextMock } from '../file/file-context-mock'
import { ConsoleContextMock } from '../console/console-context-mock'

export interface EnvironmentMock extends Environment {
  file: FileContextMock
  console: ConsoleContextMock
}
