import { WorkNodes } from '../planner/work-nodes'
import { WorkServices } from '../planner/work-services'
import { LogMode } from '../logging/log-mode'
import { SchedulerState } from './scheduler/scheduler-state'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { checkForLoop } from './scheduler/check-for-loop'
import { CacheMethod } from '../parser/cache-method'
import { State } from './state'

export interface CreateSchedulerState {
  nodes: WorkNodes
  services: WorkServices
  watch: boolean
  logMode: LogMode
  cacheMethod: CacheMethod
}

export function createSchedulerState(input: CreateSchedulerState): State {
  const state: SchedulerState = {
    service: {},
    node: {},
    cacheMethod: input.cacheMethod,
    watch: input.watch,
  }

  for (const node of iterateWorkNodes(input.nodes)) {
    state.node[node.id] = {
      type: 'pending',
      node: node,
      stateKey: null,
    }
  }

  for (const service of iterateWorkServices(input.services)) {
    state.service[service.id] = {
      type: 'pending',
      service,
      stateKey: null,
    }
  }

  checkForLoop(state)

  return new State(state)
}
