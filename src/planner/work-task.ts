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
import { WorkNetwork } from './work-network'
import { LinuxCapability } from '../schema/capabilities-schema'

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
  // what the container reaches besides its needs, as the build file declares it
  network: WorkNetwork
  // the run's `--network` ceiling, null for none; see getEffectiveNetwork
  networkCeiling: WorkNetwork | null
  // whether it takes arguments after `--` (`args`): false refuses them, null when the
  // build file doesn't say
  args: boolean | null
  // server the task has to run on, null for wherever the run happens
  runner: string | null
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
  // only groups its dependencies (deps, nothing to run or read, see isAggregateTask)
  aggregate?: boolean
}

export interface ContainerWorkTask extends BaseWorkTask {
  type: 'container-task'
  image: string
  user: string | null
  mounts: WorkMount[]
  // on Kubernetes, the size of its claim; the environment's when null
  volumeSize: string | null
  // Linux capabilities added to its container (`capAdd`), such as SYS_ADMIN
  capAdd: LinuxCapability[]
  // on a server's cluster, the pool of a local task that runs in the pool's tool image
  pool?: string
  // on a server's cluster, the architecture of the nodes it runs on (as process.arch
  // names it), which is in its cache identity instead of the server's own
  arch?: string
}

export const isContainerWorkTask = (val: WorkTask | WorkService): val is ContainerWorkTask =>
  val.type === 'container-task'
export const isWorkTask = (val: WorkTask | WorkService): val is WorkTask =>
  val.type === 'container-task' || val.type === 'local-task'

// A task that only groups its dependencies: `deps`, and no `image`, `cmds`, `src`,
// `generates`, `secrets`, `needs` or `continuous`. It needs no runtime, hands on what its dependencies generate to what
// depends on it, and is up to date (or verified) when all its dependencies are.
export const isAggregateTask = (val: WorkTask | WorkService): boolean =>
  val.type === 'local-task' && val.aggregate === true
