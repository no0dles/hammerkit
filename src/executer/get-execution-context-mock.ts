import { getEnvironmentMock } from './get-environment-mock'
import { emitter } from '../utils/emitter'
import { ExecutionContextEvent } from './execution-context-event'
import { getExecutorMock } from './executor-mock'
import { ExecutionContextMock } from './execution-context-mock'

export function getExecutionContextMock(): ExecutionContextMock {
  return {
    environment: getEnvironmentMock(),
    events: emitter<ExecutionContextEvent>(),
    executor: getExecutorMock(),
    cacheMethod: 'checksum',
    watch: false,
    runningNodes: {},
    workers: 0,
  }
}
