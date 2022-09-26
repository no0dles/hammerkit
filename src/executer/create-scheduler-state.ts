import { WorkNodes } from '../planner/work-nodes'
import { WorkServices } from '../planner/work-services'
import { CacheMethod } from '../optimizer/cache-method'
import { LogMode } from '../logging/log-mode'
import { SchedulerState } from './scheduler/scheduler-state'
import { iterateWorkNodes, iterateWorkServices } from '../planner/utils/plan-work-nodes'
import { checkForLoop } from './scheduler/check-for-loop'

export interface CreateSchedulerState {
  nodes: WorkNodes
  services: WorkServices
  watch: boolean
  workers: number
  noContainer: boolean
  cacheMethod: CacheMethod
  logMode: LogMode
}

export function createSchedulerState(input: CreateSchedulerState): SchedulerState {
  const state: SchedulerState = {
    service: {},
    node: {},
    cacheMethod: input.cacheMethod,
    noContainer: input.noContainer,
    workers: input.workers,
  }

  for (const node of iterateWorkNodes(input.nodes)) {
    state.node[node.id] = {
      type: 'pending',
      node: node,
    }
  }

  for (const service of iterateWorkServices(input.services)) {
    state.service[service.id] = {
      type: 'pending',
      service,
    }
  }

  checkForLoop(state)

  return state
}
