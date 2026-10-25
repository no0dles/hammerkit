import { LabelValues } from './label-values'

// The text after `--`, appended to the last command of the one task the scope
// selects. With `services` (`up`), a selected service takes them too: its `cmd`.
// A task given arguments runs uncached unless `cache` keeps its caching (an
// explicit `--cache <method>` on the command line).
export interface WorkArguments {
  values: string[]
  services: boolean
  cache?: boolean
}

export interface WorkTaskScope {
  taskName: string
  environmentName?: string | null
  args?: WorkArguments
}
export interface WorkLabelScope {
  filterLabels?: LabelValues
  excludeLabels?: LabelValues
  // the services to start by name, no task: what a service run on a server names
  serviceNames?: string[]
  environmentName?: string | null
  args?: WorkArguments
}

export type WorkScope = WorkTaskScope | WorkLabelScope

export const isContextTaskFilter = (target: WorkScope): target is WorkTaskScope => 'taskName' in target
