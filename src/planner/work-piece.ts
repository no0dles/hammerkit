import { StateListener } from '../executer/state-listener'

export class WorkState<S> {
  private listeners: StateListener<S>[] = []

  constructor(public current: Readonly<S>) {}

  on(listener: (evt: Readonly<S>) => void): void {
    this.listeners.push(listener)
  }

  set(data: Readonly<S>): Readonly<S> {
    this.current = data
    this.notifyListeners(this.current)
    return this.current
  }

  private notifyListeners(evt: Readonly<S>): void {
    for (const listener of this.listeners) {
      listener(evt)
    }
  }
}
