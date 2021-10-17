import { WorkNodePort } from './work-node-port'
import { WorkNodePath } from './work-node-path'
import { WorkServiceStatus } from './work-service-state'
import { ExecutionBuildServiceHealthCheck } from '../parser/build-file-service'

export interface WorkService {
  id: string
  name: string
  envs: { [key: string]: string }
  image: string
  mounts: WorkNodePath[]
  volumes: { [volumeName: string]: string }
  ports: WorkNodePort[]
  status: WorkServiceStatus
  healthcheck: ExecutionBuildServiceHealthCheck | null
}
