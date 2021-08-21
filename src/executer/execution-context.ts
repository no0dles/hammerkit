import { CacheMethod } from '../optimizer/cache-method'
import { Executor } from './executor'
import { ExecutionContextEvent } from './execution-context-event'
import { Environment } from './environment'
import { EmitterHandler } from '../utils/emitter'

export interface ExecutionContext {
  workers: number
  cacheMethod: CacheMethod
  watch: boolean

  environment: Environment
  executor: Executor
  events: EmitterHandler<ExecutionContextEvent>
}
