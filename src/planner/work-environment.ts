import { BuildFileEnvironmentSchemaIngress } from '../schema/build-file-environment-schema-ingress'

export interface WorkEnvironment {
  namespace: string
  context: string
  ingresses: BuildFileEnvironmentSchemaIngress[]
}
