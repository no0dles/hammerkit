import { array, object, string } from 'zod'
import { buildFileNeedSchema } from './build-file-need-schema'
import { envsSchema } from './envs-schema'
import { labelsSchema } from './labels-schema'
import { cacheSchema } from './cache-schema'
import { buildFileTaskCommandSchema } from './build-file-task-command-schema'
import { buildFileVolumeSchema } from './build-file-volume-schema'

export const buildFileBaseTaskSchema = object({
  deps: array(string()).optional(),
  needs: array(buildFileNeedSchema).optional(),
  description: string().optional(),
  extend: string().optional(),
  envs: envsSchema.optional(),
  labels: labelsSchema.optional(),
  cache: cacheSchema.optional(),
  cmds: array(buildFileTaskCommandSchema).optional(),
  src: array(string()).optional(),
  generates: array(buildFileVolumeSchema).optional(),
  shell: string().optional(),
})
