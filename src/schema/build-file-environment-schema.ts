import { array, object, string, union, z } from 'zod'
import { buildFileEnvironmentSchemaIngress } from './build-file-environment-schema-ingress'

export const buildFileKubernetesEnvironmentSchema = object({
  namespace: string().optional(),
  context: string(),
  ingresses: array(buildFileEnvironmentSchemaIngress).optional(),
})

export const buildFileDockerEnvironmentSchema = object({
  host: string().optional(),
}).strict()

export const buildFileEnvironmentSchema = union([
  object({
    kubernetes: buildFileKubernetesEnvironmentSchema,
  }).strict(),
  object({
    docker: buildFileDockerEnvironmentSchema,
  }).strict(),
])
export type BuildFileEnvironmentSchema = z.infer<typeof buildFileEnvironmentSchema>
