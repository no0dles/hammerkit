import { boolean, literal, object, string, union, z } from 'zod'

export const buildFileVolumeSchema = union([
  string(),
  object({
    // `always`: copied to the host even when the task fails (test reports)
    export: union([boolean(), literal('always')]).optional(),
    resetOnChange: boolean().optional(),
    path: string(),
    name: string().optional(),
    readOnly: boolean().optional(),
  }),
])

export type BuildFileVolumeSchema = z.infer<typeof buildFileVolumeSchema>
