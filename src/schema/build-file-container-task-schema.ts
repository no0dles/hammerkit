import { buildFileBaseTaskSchema } from './build-file-base-task-schema'
import { array, string, z } from 'zod'

export const buildFileContainerTaskSchema = buildFileBaseTaskSchema
  .extend({
    image: string(),
    mounts: array(string()).optional(),
  })
  .strict()
  .describe('container task')

export type BuildFileContainerTaskSchema = z.infer<typeof buildFileContainerTaskSchema>
