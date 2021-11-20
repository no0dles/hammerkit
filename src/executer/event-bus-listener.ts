import { HammerkitEvent } from './events'

export type EventBusListener<E extends HammerkitEvent> = (evt: E) => Promise<void> | void
