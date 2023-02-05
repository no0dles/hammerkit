import { z, object, record, string } from 'zod'
import { envsSchema } from './envs-schema'
import { buildFileServiceSchema } from './build-file-service-schema'
import { buildFileEnvironmentSchema } from './build-file-environment-schema'
import { buildFileTaskSchema } from './build-file-task-schema'
import { labelsSchema } from './labels-schema'

export const buildFileSchema = object({
  envs: envsSchema.optional(),
  tasks: record(buildFileTaskSchema).optional(),
  services: record(buildFileServiceSchema).optional(),
  references: record(string()).optional(),
  includes: record(string()).optional(),
  environments: record(buildFileEnvironmentSchema).optional(),
  labels: labelsSchema.optional(),
}).describe('Build file with support for containerization\nhttps://no0dles.gitbook.io/hammerkit/build-file')

export type BuildFileSchema = z.infer<typeof buildFileSchema>
