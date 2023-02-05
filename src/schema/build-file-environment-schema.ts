import { array, object, string } from 'zod'
import { buildFileEnvironmentSchemaIngress } from './build-file-environment-schema-ingress'

export const buildFileEnvironmentSchema = object({
  namespace: string(),
  context: string(),
  ingresses: array(buildFileEnvironmentSchemaIngress).optional(),
})
