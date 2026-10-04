import { array, object, string, z } from 'zod'
import { envsSchema } from './envs-schema'
import { buildFileTaskCommandSchema } from './build-file-task-command-schema'
import { durationSchema } from './duration-schema'

// A one-shot after the service passed its healthcheck: a container that runs
// its commands to completion against the service (creating buckets, seeding a
// realm, initiating a replica set) before anything needing the service starts.
export const buildFileServiceInitSchema = object({
  // defaults to the service's image
  image: string().optional(),
  // the commands run as `<shell> -c "<cmd>"`, default sh
  shell: string().optional(),
  cmds: array(buildFileTaskCommandSchema),
  envs: envsSchema.optional(),
  mounts: array(string()).optional(),
  timeout: durationSchema.optional(),
})
  .strict()
  .describe('one-shot run after the service is ready')

export type BuildFileServiceInitSchema = z.infer<typeof buildFileServiceInitSchema>
