import { NodeState } from './node-state'
import { ServiceState } from './service-state'
import { CacheMethod } from '../../optimizer/cache-method'

export interface SchedulerNodeState {
  [key: string]: NodeState
}
export interface SchedulerServiceState {
  [key: string]: ServiceState
}

export interface SchedulerState {
  abort: boolean
  node: SchedulerNodeState
  service: SchedulerServiceState
  cacheMethod: CacheMethod
  noContainer: boolean
  watch: boolean
  workers: number
}
