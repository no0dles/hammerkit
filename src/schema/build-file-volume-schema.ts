import { boolean, object, string, union, z } from 'zod'

export const buildFileVolumeSchema = union([
  string(),
  object({
    export: boolean().optional(),
    resetOnChange: boolean().optional(),
    path: string(),
    name: string().optional(),
    readOnly: boolean().optional(),
  }),
])

export type BuildFileVolumeSchema = z.infer<typeof buildFileVolumeSchema>
