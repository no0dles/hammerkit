import { string } from 'zod'
import { RESERVED_SERVER_NAMES } from '../remote/host-config'

// A server registered with `hammerkit remote add`; resolved on the machine that
// runs the build, so the build file carries no URL.
export const runnerSchema = string()
  .min(1)
  .refine((name) => !RESERVED_SERVER_NAMES.includes(name), {
    message: 'local and auto are no servers, leave runner out to run where --on or the host config says',
  })
