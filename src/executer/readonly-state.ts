import { StateListener } from './state-listener'

export interface ReadonlyState<T> {
  current: Readonly<T>

  on(listener: StateListener<T>): void
}
