import { WorkNodePort } from './work-node-port'
import { WorkNodePath } from './work-node-path'
import { ExecutionBuildServiceHealthCheck, ExecutionBuildServiceSelector } from '../parser/build-file-service'
import { StatusConsole, LogConsole } from './work-node-status'
import { CacheMethod } from '../parser/cache-method'

export interface BaseWorkService {
  id: string
  name: string
  ports: WorkNodePort[]
  console: LogConsole
  status: StatusConsole
  caching: CacheMethod
}

export type WorkService = ContainerWorkService | KubernetesWorkService

export const isContainerWorkService = (svc: WorkService): svc is ContainerWorkService => 'image' in svc

export interface ContainerWorkService extends BaseWorkService {
  envs: { [key: string]: string }
  image: string
  mounts: WorkNodePath[]
  // volumes: { [volumeName: string]: string } // TODO when cache/restore works with volumes
  healthcheck: ExecutionBuildServiceHealthCheck | null
}

export interface KubernetesWorkService extends BaseWorkService {
  context: string
  selector: ExecutionBuildServiceSelector
}
