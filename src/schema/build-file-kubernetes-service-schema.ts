import { array, number, object, string, union, z } from 'zod'
import { buildFileKubernetesServiceSelectorSchema } from './build-file-kubernetes-service-selector-schema'
import { labelsSchema } from './labels-schema'

export const buildFileKubernetesServiceSchema = object({
  kubeconfig: string().optional(),
  deps: array(string()).optional(),
  description: string().optional(),
  context: string(),
  selector: buildFileKubernetesServiceSelectorSchema,
  labels: labelsSchema.optional(),
  ports: array(union([string(), number()])),
}).strict()

export type BuildFileKubernetesServiceSchema = z.infer<typeof buildFileKubernetesServiceSchema>
