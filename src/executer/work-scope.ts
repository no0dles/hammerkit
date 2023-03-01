import { LabelValues } from './label-values'

export interface WorkTaskScope {
  taskName: string
  environmentName?: string | null
}
export interface WorkLabelScope {
  filterLabels?: LabelValues
  excludeLabels?: LabelValues
  environmentName?: string | null
}

export type WorkScope = WorkTaskScope | WorkLabelScope

export const isContextTaskFilter = (target: WorkScope): target is WorkTaskScope => 'taskName' in target
