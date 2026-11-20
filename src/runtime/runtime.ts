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
  // told whether the quota of the namespace refuses the task's pod now, each time that
  // changes: the run then holds back tasks less urgent than it (see ProcessManager)
  onQuotaRefused?: (refused: boolean) => void
}

export interface WorkRuntime<S> {
  initialize(item: State<S>): Promise<void>
  remove(environment: Environment): Promise<void>
  execute(environment: Environment, options: ExecuteOptions<S>): Promise<void>
  stop(): Promise<void>
  // `stateKey`: the state the archived outputs are of, the one the work ran at. `only`: the
  // paths of the outputs of a task to archive, every one when left out
  archive(environment: Environment, path: string, stateKey?: string, only?: string[]): Promise<void>
  // `stateKey`: the state the restored outputs are of, when the cache says
  restore(environment: Environment, path: string, stateKey?: string): Promise<void>
  currentStateKey(environment: Environment): Promise<string | null>
}
