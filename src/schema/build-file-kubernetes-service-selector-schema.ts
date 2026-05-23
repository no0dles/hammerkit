import { object, string } from 'zod'

export const buildFileKubernetesServiceSelectorSchema = object({
  type: string(),
  name: string(),
})
