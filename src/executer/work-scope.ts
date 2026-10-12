import { LabelValues } from './label-values'

// The text after `--`, appended to the last command of the one task the scope
// selects. With `services` (`up`), a selected service takes them too: its `cmd`.
export interface WorkArguments {
  values: string[]
  services: boolean
}

export interface WorkTaskScope {
  taskName: string
  environmentName?: string | null
  args?: WorkArguments
}
export interface WorkLabelScope {
  filterLabels?: LabelValues
  excludeLabels?: LabelValues
  environmentName?: string | null
  args?: WorkArguments
}

export type WorkScope = WorkTaskScope | WorkLabelScope

export const isContextTaskFilter = (target: WorkScope): target is WorkTaskScope => 'taskName' in target
