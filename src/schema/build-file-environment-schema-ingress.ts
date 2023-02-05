import { number, object, string } from 'zod'

export const buildFileEnvironmentSchemaIngress = object({
  host: string(),
  service: string(),
  servicePort: number().optional(),
  path: string().optional(),
})
