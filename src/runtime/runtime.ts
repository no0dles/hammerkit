import { Environment } from '../executer/environment'
import { CacheState } from '../executer/scheduler/enqueue-next'
import { State } from '../executer/state'

export interface ExecuteOptions<S> {
  cache: CacheState
  stateKey: string
  abort: AbortSignal
  state: State<S>
  daemon: boolean
  // publish service ports on the host: on `up`, or when a local task (which
  // reaches services through the host) needs the service
  publishPorts: boolean
  // wait for the healthcheck before the service counts as running; off only
  // for `up --wait start` on services nothing else in the run needs
  waitForReady: boolean
}

export interface WorkRuntime<S> {
  initialize(item: State<S>): Promise<void>
  remove(environment: Environment): Promise<void>
  execute(environment: Environment, options: ExecuteOptions<S>): Promise<void>
  stop(): Promise<void>
  archive(environment: Environment, path: string): Promise<void>
  restore(environment: Environment, path: string): Promise<void>
  currentStateKey(environment: Environment): Promise<string | null>
}
