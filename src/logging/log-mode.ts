import { SchedulerResult } from '../executer/scheduler/scheduler-result'
import { Environment } from '../executer/environment'

export type LogMode = 'live' | 'interactive' | 'grouped'

export interface Logger {
  complete(evt: SchedulerResult, env: Environment): Promise<void>
}
