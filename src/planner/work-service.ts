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
  // run `cmd` and the healthcheck through this shell; null = exec form
  shell: string | null
  //user: string | null
  src: WorkSource[]
  continuous: boolean
  caching: ResolvedCache
  mounts: WorkMount[]
  volumes: WorkVolume[]
  healthcheck: WorkHealthcheck | null
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
