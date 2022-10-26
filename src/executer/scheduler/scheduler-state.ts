import { NodeState } from './node-state'
import { ServiceState } from './service-state'
import { CacheMethod } from '../../parser/cache-method'

export interface SchedulerNodeState {
  [key: string]: NodeState
}
export interface SchedulerServiceState {
  [key: string]: ServiceState
}

export interface SchedulerState {
  node: SchedulerNodeState
  service: SchedulerServiceState
  cacheMethod: CacheMethod
  //noContainer: boolean
}
