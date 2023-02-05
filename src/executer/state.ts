import { StateListener } from './state-listener'
import { SchedulerState } from './scheduler/scheduler-state'
import { NodeState } from './scheduler/node-state'
import { ServiceState } from './scheduler/service-state'

export class State {
  private listeners: StateListener<SchedulerState>[] = []

  constructor(public current: SchedulerState) {}

  private assignState(state: any, newValue: any) {
    const currentKeys = Object.keys(state)
    const newKeys = Object.keys(newValue)
    const keysToRemove = currentKeys.filter((k) => newKeys.indexOf(k) === -1)

    for (const key of keysToRemove) {
      delete state[key]
    }
    for (const key of newKeys) {
      state[key] = newValue[key]
    }
  }

  resetNode<T extends NodeState>(newState: T): T {
    const state = this.current.node[newState.itemId]
    this.assignState(state, newState)
    this.notifyListeners(this.current)
    return state as T
  }

  patchNode<T extends NodeState>(newState: T, stateKey: string | null): T {
    const state = this.current.node[newState.itemId]
    if (state.stateKey === stateKey) {
      this.assignState(state, newState)
      this.notifyListeners(this.current)
    }
    return state as T
  }

  patchService(newState: ServiceState) {
    this.assignState(this.current.service[newState.itemId], newState)
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
