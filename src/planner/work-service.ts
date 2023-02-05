import { WorkPort } from './work-port'
import { WorkMount } from './work-mount'
import { WorkNode } from './work-node'
import { WorkVolume } from './work-volume'
import { LabelValues } from '../executer/label-values'
import { ParseScope } from '../schema/parse-context'
import { WorkSource } from './work-source'
import { WorkHealthcheck } from './work-healthcheck'
import { WorkKubernetesSelector } from './work-kubernetes-selector'
import { WorkCommand } from './work-command'

export interface BaseWorkService {
  name: string
  description: string | null
  ports: WorkPort[]
  labels: LabelValues
  scope: ParseScope
}

export type WorkService = ContainerWorkService | KubernetesWorkService

export const isContainerWorkService = (
  svc: WorkService | WorkNode | KubernetesWorkService
): svc is ContainerWorkService => 'image' in svc && svc.type === 'container-service'

export interface ContainerWorkService extends BaseWorkService {
  type: 'container-service'
  envs: { [key: string]: string }
  image: string
  cmd: WorkCommand | null
  cwd: string | null
  //user: string | null
  src: WorkSource[]
  mounts: WorkMount[]
  volumes: WorkVolume[]
  healthcheck: WorkHealthcheck | null
}

export interface KubernetesWorkService extends BaseWorkService {
  type: 'kubernetes-service'
  context: string
  kubeconfig: string
  selector: WorkKubernetesSelector
}
