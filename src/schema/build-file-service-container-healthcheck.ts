import { object, string } from 'zod'
import { durationSchema } from './duration-schema'

export const buildFileServiceContainerHealthcheck = object({
  cmd: string(),
  // How long the service may take to pass `cmd` once its container runs
  // (default 20s, HAMMERKIT_HEALTHCHECK_TIMEOUT changes the default).
  timeout: durationSchema.optional(),
})
