import { array, never, object, string, union, z } from 'zod'
import { buildFileEnvironmentSchemaHttpRoute } from './build-file-environment-schema-http-route'

export const buildFileKubernetesEnvironmentSchema = object({
  namespace: string().optional(),
  context: string(),
  kubeconfig: string().optional(),
  httpRoutes: array(buildFileEnvironmentSchemaHttpRoute).optional(),
  // Ingress support was removed in 1.8.0. Fail instead of dropping the routes.
  ingresses: never({
    errorMap: () => ({
      message: 'ingresses were removed in 1.8.0: declare Gateway API routes under httpRoutes, each with a gateway',
    }),
  }).optional(),
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
