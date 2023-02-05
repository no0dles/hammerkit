import { object, string } from 'zod'

export const buildFileServiceContainerHealthcheck = object({
  cmd: string(),
})
