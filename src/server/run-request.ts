import { z } from 'zod'

const name = z.string().min(1).max(200)

// What `POST /v1/runs` takes. Who is asking, which accounts they may use and
// where code may come from is decided from the token, never from this body.
export const runRequestSchema = z
  .object({
    // tasks by their name in the build file, as on the command line
    tasks: z.array(name).min(1, 'name at least one task').max(100),
    // the service account to use; the caller's default when left out
    account: name.optional(),
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('ref'), ref: name }).strict(),
      z.object({ type: z.literal('upload'), snapshot: name }).strict(),
    ]),
  })
  .strict()

export type RunRequest = z.infer<typeof runRequestSchema>
