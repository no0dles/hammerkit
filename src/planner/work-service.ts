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
import { CacheMethod } from '../parser/cache-method'
import { WorkEnvironmentVariables } from '../environment/replace-env-variables'

export interface BaseWorkService {
  name: string
  cwd: string
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
  //user: string | null
  src: WorkSource[]
  continuous: boolean
  caching: CacheMethod | null
  mounts: WorkMount[]
  volumes: WorkVolume[]
  healthcheck: WorkHealthcheck | null
}

export interface KubernetesWorkService extends BaseWorkService {
  type: 'kubernetes-service'
  context: string
  kubeconfig: string
  caching: CacheMethod | null
  selector: WorkKubernetesSelector
  src: WorkSource[]
}
