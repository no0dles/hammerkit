import { z, object, record } from 'zod'
import { envsSchema } from './envs-schema'
import { buildFileServiceSchema } from './build-file-service-schema'
import { buildFileEnvironmentSchema } from './build-file-environment-schema'
import { buildFileTaskSchema } from './build-file-task-schema'
import { labelsSchema } from './labels-schema'
import { buildFileCacheSchema } from './cache-schema'
import { buildFileIncludeSchema } from './build-file-include-schema'
import { runnerSchema } from './runner-schema'

export const buildFileSchema = object({
  envs: envsSchema.optional(),
  tasks: record(buildFileTaskSchema).optional(),
  services: record(buildFileServiceSchema).optional(),
  references: record(buildFileIncludeSchema).optional(),
  includes: record(buildFileIncludeSchema).optional(),
  environments: record(buildFileEnvironmentSchema).optional(),
  caches: record(buildFileCacheSchema).optional(),
  labels: labelsSchema.optional(),
  // default `runner` of the tasks of this file
  runner: runnerSchema.optional(),
})
  .strict()
  .describe('Build file with support for containerization\nhttps://hammerkit.dev/docs/build-file')

export type BuildFileSchema = z.infer<typeof buildFileSchema>
