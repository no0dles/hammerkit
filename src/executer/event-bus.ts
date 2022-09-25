import { HammerkitEvent } from './events'
import { EventBusListener } from './event-bus-listener'

export class EventBus {
  private listeners: { [key: string]: EventBusListener<any>[] } = {}

  constructor() {}

  on<E extends HammerkitEvent>(type: E['type'], listener: EventBusListener<E>): void {
    if (!this.listeners[type]) {
      this.listeners[type] = []
    }
    this.listeners[type].push(listener)
  }

  async emit(event: HammerkitEvent): Promise<void> {
    const listeners = this.listeners[event.type] || []
    await Promise.all(listeners.map((l) => l(event)))
  }

  run<R extends HammerkitEvent>(listenerType: R['type'], startEvent: HammerkitEvent): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      this.on(listenerType, (evt) => {
        resolve(evt)
      })
      this.emit(startEvent).catch((err) => reject(err))
    })
  }
}
