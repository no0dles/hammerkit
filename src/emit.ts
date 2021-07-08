export interface EmitListener<T> {
  (value: T): void | Promise<void>
}

export interface EmitHandle {
  close(): void
}

export interface Emitter<T> {
  on(listener: EmitListener<T>): EmitHandle
}

export interface EmitterHandler<T> extends Emitter<T> {
  emit(value: T): void
}

export function emitter<T>(): EmitterHandler<T> {
  const listeners: EmitListener<T>[] = []

  return {
    on(listener: EmitListener<T>): EmitHandle {
      listeners.push(listener)
      return {
        close() {
          const index = listeners.indexOf(listener)
          if (index >= 0) {
            listeners.splice(index, 1)
          }
        },
      }
    },
    emit(value: T) {
      for (const listener of listeners) {
        listener(value)
      }
    },
  }
}
