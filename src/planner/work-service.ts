import { WorkSecret } from './work-secret'
import { WorkPort } from './work-port'
import { WorkMount } from './work-mount'
import { WorkTask } from './work-task'
import { WorkVolume } from './work-volume'
import { LabelValues } from '../executer/label-values'
import { ParseScope } from '../schema/parse-context'
import { WorkSource } from './work-source'
import { WorkHealthcheck } from './work-healthcheck'
import { WorkKubernetesSelector } from './work-kubernetes-selector'
import { WorkCommand } from './work-command'
import { ResolvedCache } from '../cache/resolve-cache'
import { WorkEnvironmentVariables } from '../environment/replace-env-variables'
import { WorkItemState } from './work-item'
import { TaskState } from '../executer/scheduler/task-state'
import { ServiceState } from '../executer/scheduler/service-state'
import { State } from '../executer/state'

export interface BaseWorkService {
  name: string
  cwd: string
  // anchor for machine-independent cache identity (see findProjectRoot)
  projectRoot: string
  description: string | null
  ports: WorkPort[]
  labels: LabelValues
  scope: ParseScope
}

export type WorkService = ContainerWorkService | KubernetesWorkService

export const isContainerWorkService = (
  svc: WorkService | WorkTask | KubernetesWorkService
): svc is ContainerWorkService => 'image' in svc && svc.type === 'container-service'

export interface ContainerWorkService extends BaseWorkService {
  type: 'container-service'
  envs: WorkEnvironmentVariables
  image: string
  cmd: WorkCommand | null
  // explicit container working directory; null = the build file's directory (cwd)
  workdir: string | null
  // run `cmd` and the healthcheck through this shell; null = exec form
  shell: string | null
  //user: string | null
  src: WorkSource[]
  continuous: boolean
  caching: ResolvedCache
  mounts: WorkMount[]
  volumes: WorkVolume[]
  healthcheck: WorkHealthcheck | null
  // one-shot after the healthcheck passed, before dependents start
  init: WorkServiceInit | null
  secrets: WorkSecret[]
}

export interface WorkServiceInit {
  // the task named by `init`, planned like any other task
  task: WorkItemState<WorkTask, TaskState>
  // the service as its init task sees it: running once the healthcheck passed,
  // while everything else still waits for the init to succeed
  state: State<ServiceState>
}

export interface KubernetesWorkService extends BaseWorkService {
  type: 'kubernetes-service'
  context: string
  kubeconfig: string
  namespace: string
  caching: ResolvedCache
  selector: WorkKubernetesSelector
  src: WorkSource[]
}

// The container's working directory: the declared `workdir`, else the build
// file's directory (the default every runtime applied before `workdir`).
export const getServiceWorkingDir = (service: ContainerWorkService): string => service.workdir ?? service.cwd
// The container's entrypoint and command for a service: with a `shell`, its
// `cmd` runs as `<shell> -c "<cmd>"` in place of the image entrypoint; without
// one the tokenized `cmd` becomes the command and the image entrypoint stays.
export function getServiceCommand(service: ContainerWorkService): {
  entrypoint: string[] | null
  cmd: string[] | null
} {
  if (!service.cmd) {
    return { entrypoint: null, cmd: null }
  }
  if (service.shell) {
    return { entrypoint: [service.shell, '-c'], cmd: [service.cmd.cmd] }
  }
  return { entrypoint: null, cmd: [service.cmd.parsed.command, ...service.cmd.parsed.args] }
}

// The healthcheck as an exec command, through the service's `shell` if it has one.
export function getHealthcheckCommand(service: ContainerWorkService): string[] | null {
  if (!service.healthcheck) {
    return null
  }
  const cmd = service.healthcheck.cmd
  return service.shell ? [service.shell, '-c', cmd.cmd] : [cmd.parsed.command, ...cmd.parsed.args]
}
