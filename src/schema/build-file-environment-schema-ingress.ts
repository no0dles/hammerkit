import { number, object, string, z } from 'zod'

export const buildFileEnvironmentSchemaIngress = object({
  host: string(),
  service: string(),
  servicePort: number().optional(),
  path: string().optional(),
}).strict()
export type BuildFileEnvironmentSchemaIngress = z.infer<typeof buildFileEnvironmentSchemaIngress>
