import { WorkNodePort } from './work-node-port'
import { WorkNodePath } from './work-node-path'
import {
  ExecutionBuildService,
  ExecutionBuildServiceHealthCheck,
  ExecutionBuildServiceSelector,
} from '../parser/build-file-service'
import { WorkServiceVolume } from './work-service-volume'

export interface BaseWorkService {
  id: string
  name: string
  description: string | null
  ports: WorkNodePort[]
  buildService: ExecutionBuildService
}

export type WorkService = ContainerWorkService | KubernetesWorkService

export const isContainerWorkService = (svc: WorkService): svc is ContainerWorkService =>
  'image' in svc && svc.type === 'container-service'

export interface ContainerWorkService extends BaseWorkService {
  type: 'container-service'
  envs: { [key: string]: string }
  image: string
  cmd: string | null
  mounts: WorkNodePath[]
  volumes: WorkServiceVolume[]
  healthcheck: ExecutionBuildServiceHealthCheck | null
}

export interface KubernetesWorkService extends BaseWorkService {
  type: 'kubernetes-service'
  context: string
  kubeconfig: string
  selector: ExecutionBuildServiceSelector
}
