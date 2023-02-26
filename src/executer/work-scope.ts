import { LabelValues } from './label-values'

export interface WorkTaskScope {
  taskName: string
}
export interface WorkLabelScope {
  filterLabels?: LabelValues
  excludeLabels?: LabelValues
}

export type WorkScope = WorkTaskScope | WorkLabelScope

export function emptyWorkLabelScope(): WorkLabelScope {
  return { excludeLabels: {}, filterLabels: {} }
}

export const isContextTaskFilter = (target: WorkScope): target is WorkTaskScope => 'taskName' in target
