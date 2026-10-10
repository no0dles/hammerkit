import { WorkSource } from './work-source'
import { WorkCommand } from './work-command'
import { WorkService } from './work-service'
import { ResolvedCache } from '../cache/resolve-cache'
import { LabelValues } from '../executer/label-values'
import { WorkMount } from './work-mount'
import { ParseScope } from '../schema/parse-context'
import { WorkEnvironmentVariables } from '../environment/replace-env-variables'
import { WorkItem } from './work-item'
import { WorkSecret } from './work-secret'
import { WorkResources } from './work-resources'

// `task`: the task's own envs; `input`: a value the including file passed with
// `with`; `build-file`: the top-level envs of its build file; `extend`: carried
// from the task it extends.
export type WorkEnvOrigin = 'task' | 'input' | 'build-file' | 'extend'

export type WorkTask = LocalWorkTask | ContainerWorkTask

export interface BaseWorkTask {
  name: string
  cwd: string
  // anchor for machine-independent cache identity (see findProjectRoot)
  projectRoot: string
  description: string | null
  src: WorkSource[]
  generates: WorkTaskGenerate[]
  envs: WorkEnvironmentVariables
  // where each variable was declared, for `explain --definition`
  envOrigins: { [key: string]: WorkEnvOrigin }
  cmds: WorkCommand[]
  scope: ParseScope
  labels: LabelValues
  shell: string
  caching: ResolvedCache
  continuous: boolean
  // maximum execution time in ms, null for none
  timeout: number | null
  secrets: WorkSecret[]
  // container limits, null for none; a hint only for a local task
  resources: WorkResources | null
}

export interface WorkTaskGenerate {
  path: string
  volumeName: string
  inherited: WorkItem<WorkTask> | null
  resetOnChange: boolean
  export: boolean
  // `export: always`: copied out of the container when the task fails too
  exportAlways: boolean
  isFile: boolean
}

export interface LocalWorkTask extends BaseWorkTask {
  type: 'local-task'
}

export interface ContainerWorkTask extends BaseWorkTask {
  type: 'container-task'
  image: string
  user: string | null
  mounts: WorkMount[]
}

export const isContainerWorkTask = (val: WorkTask | WorkService): val is ContainerWorkTask =>
  val.type === 'container-task'
export const isWorkTask = (val: WorkTask | WorkService): val is WorkTask =>
  val.type === 'container-task' || val.type === 'local-task'
