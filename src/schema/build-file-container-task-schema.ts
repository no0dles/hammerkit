import { buildFileBaseTaskSchema } from './build-file-base-task-schema'
import { array, string, z } from 'zod'
import { sizeSchema } from './size-schema'

export const buildFileContainerTaskSchema = buildFileBaseTaskSchema
  .extend({
    image: string(),
    mounts: array(string()).optional(),
    // on Kubernetes, the size of the claim that holds its sources, mounts and outputs
    volumeSize: sizeSchema.describe('size of its claim on Kubernetes, e.g. 10Gi').optional(),
  })
  .strict()
  .describe('container task')

export type BuildFileContainerTaskSchema = z.infer<typeof buildFileContainerTaskSchema>
