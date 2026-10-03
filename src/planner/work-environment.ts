import { BuildFileEnvironmentSchemaHttpRoute } from '../schema/build-file-environment-schema-http-route'

export type WorkEnvironment = WorkKubernetesEnvironment | WorkDockerEnvironment

export interface WorkDockerEnvironment {
  type: 'docker'
  host?: string
}

export interface WorkKubernetesEnvironment {
  type: 'kubernetes'
  namespace: string
  kubeConfig?: string
  context: string
  httpRoutes: BuildFileEnvironmentSchemaHttpRoute[]
  storageClass?: string
}
