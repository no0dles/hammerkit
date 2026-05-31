import { object, string, union, z } from 'zod'

export const buildFileTaskCommandSchema = union([
  string(),
  object({
    cmd: string(),
    path: string().optional(),
  }),
])

export type BuildFileTaskCommandSchema = z.infer<typeof buildFileTaskCommandSchema>
