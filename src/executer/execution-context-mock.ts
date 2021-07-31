import { ExecutionContext } from './execution-context'
import { ExecutorMock } from './executor-mock'
import { EnvironmentMock } from './environment-mock'

export interface ExecutionContextMock extends ExecutionContext {
  executor: ExecutorMock
  environment: EnvironmentMock
}
