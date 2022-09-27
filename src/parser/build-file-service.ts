export interface ExecutionBuildService {
  envs: { [key: string]: string } | null
  image: string
  ports: string[] | null
  mounts: string[] | null
  //volumes: { [key: string]: string } | null
  healthcheck: ExecutionBuildServiceHealthCheck | null
  unknownProps: { [key: string]: any }
  labels: { [key: string]: string }
}

export interface ExecutionBuildServiceHealthCheck {
  cmd: string
}
