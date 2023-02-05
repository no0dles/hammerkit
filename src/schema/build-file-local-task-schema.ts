import { buildFileBaseTaskSchema } from './build-file-base-task-schema'
import { buildFileLocalPlatformSchema } from './build-file-local-platform-schema'
import { z } from 'zod'

export const buildFileLocalTaskSchema = buildFileBaseTaskSchema.extend({
  platform: buildFileLocalPlatformSchema.optional(),
})

export type BuildFileLocalTaskSchema = z.infer<typeof buildFileLocalTaskSchema>
