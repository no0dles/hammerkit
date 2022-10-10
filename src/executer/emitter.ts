import { listenOnAbort } from '../utils/abort-event'

export type Process<T, E> = (abort: AbortSignal, emitter: ProgressHub<E>) => Promise<T>

export interface ProcessItem<T> {
  key: string
  promise: Promise<ProcessPromise<T>>
}

export type ProcessPromise<T> =
  | { item: ProcessItem<T>; value: T; type: 'completed' }
  | { item: ProcessItem<T>; error: unknown; type: 'error' }
  | { type: 'interupt' }

export interface ProgressHub<T> {
  emit(evt: T): void
}

export interface UpdateBus<T extends { type: string }> {
  on<E extends T>(type: T['type'], listener: (evt: E) => void): void
}

export type ProcessMapper<R, T> = (key: string, process: Process<R, T>) => Process<R, T>

export class UpdateEmitter<T extends { type: string }> implements ProgressHub<T>, UpdateBus<T> {
  private processes: ProcessItem<T>[] = []
  private interuptNext?: (val: { type: 'interupt' }) => void
  private listeners = new Map<string, ((evt: any) => void)[]>()

  constructor(private abort: AbortController, private taskMapper: ProcessMapper<any, T> = (key, process) => process) {}

  task<R extends T>(key: string, process: Process<R, T>): AbortController {
    const abortController = new AbortController()
    listenOnAbort(this.abort.signal, () => {
      abortController.abort()
    })

    const item: ProcessItem<R> = {
      key,
      promise: this.taskMapper(key, process)(abortController.signal, this)
        .then<ProcessPromise<R>>((value) => ({ item, value, type: 'completed' }))
        .catch((error) => ({ item, error, type: 'error' })),
    }

    this.processes.push(item)
    if (this.interuptNext) {
      this.interuptNext({ type: 'interupt' })
    }

    return abortController
  }

  async next(): Promise<T | null> {
    if (this.processes.length === 0) {
      return null
    }

    const result = await Promise.race([
      new Promise<{ type: 'interupt' }>((resolve) => {
        this.interuptNext = resolve
      }),
      ...this.processes.map((p) => p.promise),
    ])
    if (result.type === 'interupt') {
      return this.next() // TODO stackoverflow
    }
    const index = this.processes.indexOf(result.item)
    this.processes.splice(index, 1)
    if (result.type === 'completed') {
      this.notifyListeners(result.value)
      return result.value
    } else {
      throw result.error
    }
  }

  private notifyListeners(evt: T): void {
    const listeners = this.listeners.get(evt.type)
    if (!listeners) {
      return
    }

    for (const listener of listeners) {
      listener(evt)
    }
  }

  emit(evt: T): void {
    const item: ProcessItem<T> = {
      key: evt.type,
      promise: Promise.resolve().then<ProcessPromise<T>>(() => ({ item, value: evt, type: 'completed' })),
    }
    this.processes.push(item)
    if (this.interuptNext) {
      this.interuptNext({ type: 'interupt' })
    }
  }

  on<E extends T>(type: E['type'], listener: (evt: E) => void): void {
    const listeners = this.listeners.get(type)
    if (!listeners) {
      this.listeners.set(type, [listener])
    } else {
      listeners.push(listener)
    }
  }

  async close() {
    this.abort.abort()
    await Promise.allSettled(this.processes.map((p) => p.promise))
  }
}
