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
  // explicit container working directory; null = the build file's directory (cwd)
  workdir: string | null
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

// The container's working directory: the declared `workdir`, else the build
// file's directory (the default every runtime applied before `workdir`).
export const getServiceWorkingDir = (service: ContainerWorkService): string => service.workdir ?? service.cwd
