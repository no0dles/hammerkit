import { array, boolean, object, string } from 'zod'
import { buildFileNeedSchema } from './build-file-need-schema'
import { envsSchema } from './envs-schema'
import { labelsSchema } from './labels-schema'
import { cacheSchema } from './cache-schema'
import { buildFileTaskCommandSchema } from './build-file-task-command-schema'
import { buildFileVolumeSchema } from './build-file-volume-schema'
import { durationSchema } from './duration-schema'
import { buildFileSecretSchema } from './build-file-secret-schema'
import { resourcesSchema } from './resources-schema'

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
  // A task that watches its own sources and restarts itself (e.g. `ng serve`,
  // `tsc -w`). In watch mode hammerkit then does not watch/restart it itself.
  continuous: boolean().optional(),
  // Maximum execution time, e.g. `30s`, `10m`, `1h30m`. The task fails when it
  // runs longer. Does not affect the cache key (ADR-0002).
  timeout: durationSchema.optional(),
  secrets: array(buildFileSecretSchema).optional(),
  // CPU and memory limits of the container; a local task is not limited
  resources: resourcesSchema.optional(),
})
