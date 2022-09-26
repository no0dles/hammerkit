import { SchedulerResult } from '../executer/scheduler/scheduler-result'

export type LogMode = 'live' | 'interactive' | 'grouped'

export interface Logger {
  complete(evt: SchedulerResult): Promise<void>
}
