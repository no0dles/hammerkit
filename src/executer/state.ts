import { StateListener } from './state-listener'

export interface StateHandle {
  close(): void
}

export class State<T> {
  private listeners: { key: string; listener: StateListener<T> }[] = []

  constructor(public current: Readonly<T>, private subStates: State<any>[] = []) {
    this.attachToStores(subStates)
  }

  private attachToStores(subStates: State<any>[]) {
    for (const state of subStates) {
      state.on('sub-state-forward', () => {
        this.notifyListeners(this.current)
      })
    }
  }

  set(newState: T): Readonly<T> {
    this.current = newState
    this.notifyListeners(newState)
    return this.current
  }

  on(key: string, listener: (evt: T) => void): StateHandle {
    this.listeners.push({ key, listener })
    return {
      close: () => {
        const index = this.listeners.findIndex((l) => l.key === key && l.listener === listener)
        if (index >= 0) {
          this.listeners.splice(index, 1)
        } else {
          // TODO warn
        }
      },
    }
  }

  private notifyListeners(evt: T): void {
    for (const listener of [...this.listeners]) {
      listener.listener(evt)
    }
  }
}
