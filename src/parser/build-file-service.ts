export interface ExecutionBuildService {
  envs: { [key: string]: string } | null
  image: string | null
  description: string | null
  ports: string[] | null
  mounts: string[] | null
  deps: string[] | null
  needs: (string | ExecutionServiceNeed)[] | null
  cmd: string | null
  volumes: string[] | null
  healthcheck: ExecutionBuildServiceHealthCheck | null
  unknownProps: { [key: string]: any }
  labels: { [key: string]: string }
  context: string | null
  kubeconfig: string | null
  selector: ExecutionBuildServiceSelector | null
}

export interface ExecutionServiceNeed {
  service: string
  name: string
}

export interface ExecutionBuildServiceSelector {
  type: string
  name: string
}

export interface ExecutionBuildServiceHealthCheck {
  cmd: string
}
