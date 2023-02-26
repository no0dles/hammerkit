import { array, object, string, z } from 'zod'
import { buildFileEnvironmentSchemaIngress } from './build-file-environment-schema-ingress'

export const buildFileEnvironmentSchema = object({
  namespace: string(),
  context: string(),
  ingresses: array(buildFileEnvironmentSchemaIngress).optional(),
}).strict()
export type BuildFileEnvironmentSchema = z.infer<typeof buildFileEnvironmentSchema>
