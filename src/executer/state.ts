import { StateListener } from './state-listener'
import { SchedulerState } from './scheduler/scheduler-state'
import { NodeState } from './scheduler/node-state'
import { ServiceState } from './scheduler/service-state'

export class State {
  private listeners: StateListener<SchedulerState>[] = []

  constructor(public current: Readonly<SchedulerState>) {}

  patchNode(newState: NodeState) {
    const newValue: SchedulerState = {
      ...this.current,
      node: {
        ...this.current.node,
      },
    }
    newValue.node[newState.node.id] = newState
    this.current = newValue
    this.notifyListeners(this.current)
  }

  patchService(newState: ServiceState) {
    const newValue: SchedulerState = {
      ...this.current,
      service: {
        ...this.current.service,
      },
    }
    newValue.service[newState.service.id] = newState
    this.current = newValue
    this.notifyListeners(this.current)
  }

  on(listener: (evt: SchedulerState) => void): void {
    this.listeners.push(listener)
    listener(this.current)
  }

  private notifyListeners(evt: SchedulerState): void {
    for (const listener of this.listeners) {
      listener(evt)
    }
  }
}
