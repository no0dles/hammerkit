import { buildFileBaseTaskSchema } from './build-file-base-task-schema'
import { array, string, z } from 'zod'
import { sizeSchema } from './size-schema'
import { capabilitiesSchema } from './capabilities-schema'

export const buildFileContainerTaskSchema = buildFileBaseTaskSchema
  .extend({
    image: string(),
    mounts: array(string()).optional(),
    // on Kubernetes, the size of the claim that holds its sources, mounts and outputs
    volumeSize: sizeSchema.describe('size of its claim on Kubernetes, e.g. 10Gi').optional(),
    // Linux capabilities added to the container, such as SYS_ADMIN for a daemonless image
    // build. A server allows them only in a sandboxed runtime (`backend.capabilities`).
    capAdd: capabilitiesSchema.describe('Linux capabilities added to the container, e.g. [SYS_ADMIN]').optional(),
  })
  .strict()
  .describe('container task')

export type BuildFileContainerTaskSchema = z.infer<typeof buildFileContainerTaskSchema>
