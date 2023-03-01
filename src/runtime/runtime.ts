import { Environment } from '../executer/environment'
import { CacheState } from '../executer/scheduler/enqueue-next'
import { State } from '../executer/state'

export interface ExecuteOptions<S> {
  cache: CacheState
  stateKey: string
  abort: AbortSignal
  state: State<S>
  daemon: boolean
}

export interface WorkRuntime<S> {
  initialize(item: State<S>): Promise<void>
  remove(environment: Environment): Promise<void>
  execute(environment: Environment, options: ExecuteOptions<S>): Promise<void>
  stop(): Promise<void>
  archive(environment: Environment, path: string): Promise<void>
  restore(environment: Environment, path: string): Promise<void>
}
