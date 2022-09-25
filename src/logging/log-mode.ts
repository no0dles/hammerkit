import { SchedulerTerminationEvent } from '../executer/events'

export type LogMode = 'live' | 'interactive' | 'grouped'

export interface Logger {
  complete(evt: SchedulerTerminationEvent): Promise<void>
}
