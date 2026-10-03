import { number, object, string, z } from 'zod'

// A Gateway API HTTPRoute exposing a service of the environment under a hostname.
export const buildFileEnvironmentSchemaHttpRoute = object({
  host: string(),
  service: string(),
  servicePort: number().optional(),
  path: string().optional(),
  // the parent Gateway the route attaches to
  gateway: string(),
  gatewayNamespace: string().optional(),
}).strict()
export type BuildFileEnvironmentSchemaHttpRoute = z.infer<typeof buildFileEnvironmentSchemaHttpRoute>
