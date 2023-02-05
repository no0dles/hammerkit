import { array, number, object, string, union, z } from 'zod'
import { envsSchema } from './envs-schema'
import { buildFileNeedSchema } from './build-file-need-schema'
import { labelsSchema } from './labels-schema'
import { buildFileServiceContainerHealthcheck } from './build-file-service-container-healthcheck'

export const buildFileContainerServiceSchema = object({
  image: string(),
  description: string().optional(),
  ports: array(union([string(), number()])),
  envs: envsSchema.optional(),
  mounts: array(string()).optional(),
  deps: array(string()).optional(),
  src: array(string()).optional(),
  needs: array(buildFileNeedSchema).optional(),
  cmd: string().optional(),
  volumes: array(string()).optional(),
  labels: labelsSchema.optional(),
  healthcheck: buildFileServiceContainerHealthcheck.optional(),
})

export type BuildFileContainerServiceSchema = z.infer<typeof buildFileContainerServiceSchema>
