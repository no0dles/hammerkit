import { LabelValues } from './label-values'

export interface WorkTaskScope {
  taskName: string
}
export interface WorkLabelScope {
  filterLabels: LabelValues
  excludeLabels: LabelValues
  mode: WorkScopeMode
}

export type WorkScopeMode = 'service' | 'all'

export type WorkScope = WorkTaskScope | WorkLabelScope

export function emptyWorkLabelScope(mode: WorkScopeMode): WorkLabelScope {
  return { excludeLabels: {}, filterLabels: {}, mode }
}

export const isContextTaskFilter = (target: WorkScope): target is WorkTaskScope => 'taskName' in target
