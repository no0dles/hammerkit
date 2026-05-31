import { object, string, union } from 'zod'

export const buildFileNeedSchema = union([
  string(),
  object({
    service: string(),
    name: string(),
  }),
])
