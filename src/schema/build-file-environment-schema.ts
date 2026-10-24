import { array, literal, never, object, string, union, z } from 'zod'
import { buildFileEnvironmentSchemaHttpRoute } from './build-file-environment-schema-http-route'
import { sizeSchema } from './size-schema'

export const buildFileKubernetesEnvironmentSchema = object({
  namespace: string().optional(),
  context: string(),
  kubeconfig: string().optional(),
  httpRoutes: array(buildFileEnvironmentSchemaHttpRoute).optional(),
  // Hammerkit can't tell from the API whether the cluster's network plugin
  // enforces NetworkPolicy, so the build file states it before any task or
  // service there may have a limited network.
  networkPolicy: literal('enforced')
    .describe('the cluster enforces NetworkPolicy, which limited networks need')
    .optional(),
  // the size of the claim of a task or service that states none (1Gi when left out)
  volumeSize: sizeSchema.describe('size of the claim of each task and service, 1Gi by default').optional(),
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
