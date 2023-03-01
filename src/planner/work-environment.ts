import { BuildFileEnvironmentSchemaIngress } from '../schema/build-file-environment-schema-ingress'

export type WorkEnvironment = WorkKubernetesEnvironment | WorkDockerEnvironment

export interface WorkDockerEnvironment {
  type: 'docker'
  host?: string
}

export interface WorkKubernetesEnvironment {
  type: 'kubernetes'
  namespace: string
  context: string
  ingresses: BuildFileEnvironmentSchemaIngress[]
}
