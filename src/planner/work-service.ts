import { WorkNodePort } from './work-node-port'
import { WorkNodePath } from './work-node-path'
import {
  ExecutionBuildService,
  ExecutionBuildServiceHealthCheck,
  ExecutionBuildServiceSelector,
} from '../parser/build-file-service'

export interface BaseWorkService {
  id: string
  name: string
  description: string | null
  ports: WorkNodePort[]
  buildService: ExecutionBuildService
}

export type WorkService = ContainerWorkService | KubernetesWorkService // | LocalWorkService

export const isContainerWorkService = (svc: WorkService): svc is ContainerWorkService => 'image' in svc

export interface ContainerWorkService extends BaseWorkService {
  type: 'container'
  envs: { [key: string]: string }
  image: string
  cmd: string | null
  mounts: WorkNodePath[]
  // volumes: { [volumeName: string]: string } // TODO when cache/restore works with volumes
  healthcheck: ExecutionBuildServiceHealthCheck | null
}

// export interface LocalWorkService extends BaseWorkService {
//   type: 'local'
//   envs: { [key: string]: string }
//   cmd: string
//   healthcheck: ExecutionBuildServiceHealthCheck | null
// }

export interface KubernetesWorkService extends BaseWorkService {
  type: 'kubernetes'
  context: string
  kubeconfig: string
  selector: ExecutionBuildServiceSelector
}
