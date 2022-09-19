import { HammerkitEvent } from './events'
import { EventBusListener } from './event-bus-listener'

export class EventBus {
  private listeners: { [key: string]: EventBusListener<any>[] } = {}

  on<E extends HammerkitEvent>(type: E['type'], listener: EventBusListener<E>, prio = false): void {
    if (!this.listeners[type]) {
      this.listeners[type] = []
    }
    if (prio) {
      this.listeners[type].unshift(listener)
    } else {
      this.listeners[type].push(listener)
    }
  }

  async emit(event: HammerkitEvent): Promise<void> {
    const listeners = this.listeners[event.type] || []
    for (const listener of listeners) {
      await listener(event)
    }
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
