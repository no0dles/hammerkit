import { number, object, string, z } from 'zod'

export const buildFileEnvironmentSchemaIngress = object({
  kind: z.enum(['ingress', 'httproute']).optional(),
  host: string(),
  service: string(),
  servicePort: number().optional(),
  path: string().optional(),
  gateway: string().optional(),
  gatewayNamespace: string().optional(),
}).strict()
export type BuildFileEnvironmentSchemaIngress = z.infer<typeof buildFileEnvironmentSchemaIngress>
