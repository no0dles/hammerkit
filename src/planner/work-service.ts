import { WorkNodePort } from './work-node-port'
import { WorkNodePath } from './work-node-path'
import { ExecutionBuildServiceHealthCheck } from '../parser/build-file-service'
import { StatusConsole, LogConsole } from './work-node-status'

export interface WorkService {
  id: string
  name: string
  envs: { [key: string]: string }
  image: string
  mounts: WorkNodePath[]
  volumes: { [volumeName: string]: string }
  ports: WorkNodePort[]
  console: LogConsole
  healthcheck: ExecutionBuildServiceHealthCheck | null
  status: StatusConsole
}
