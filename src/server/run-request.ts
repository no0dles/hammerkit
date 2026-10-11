import { z } from 'zod'
import { parseDuration } from '../utils/units'

const name = z.string().min(1).max(200)

// What `POST /v1/runs` takes. Who is asking, which accounts they may use and
// where code may come from is decided from the token, never from this body.
// Relative to the source, so a run can't point at files of the server.
const buildFile = name.refine(
  (value) => !value.startsWith('/') && !value.includes('\\') && !value.split('/').includes('..'),
  'the build file is a path inside the source'
)

const duration = z.string().refine((value) => {
  try {
    parseDuration(value)
    return true
  } catch {
    return false
  }
}, 'expected a duration like 30s, 5m or 1h30m')

// The settings of `hammerkit run` that make sense for a run on a server. What
// the server limits itself (workers, resources) and what only a terminal
// needs (watch, log mode) are left out.
export const runOptionsSchema = z
  .object({
    // the build file inside the source, the usual file name when left out
    file: buildFile.optional(),
    // as --env
    env: name.optional(),
    // as --filter and --exclude: labels
    filter: z.array(name).max(20).optional(),
    exclude: z.array(name).max(20).optional(),
    // as --cache
    cache: z.enum(['checksum', 'modify-date', 'none']).optional(),
    // as --cache-read-only
    cacheReadOnly: z.boolean().optional(),
    // as --timeout
    timeout: duration.optional(),
    // as --no-skip-deps when false
    skipDeps: z.boolean().optional(),
  })
  .strict()

export const runRequestSchema = z
  .object({
    // tasks by their name in the build file, as on the command line; labels in
    // the options can select tasks instead
    tasks: z.array(name).max(100).default([]),
    // the service account to use; the caller's default when left out
    account: name.optional(),
    source: z.discriminatedUnion('type', [
      z.object({ type: z.literal('ref'), ref: name }).strict(),
      z.object({ type: z.literal('upload'), snapshot: name }).strict(),
    ]),
    options: runOptionsSchema.default({}),
  })
  .strict()
  .refine((request) => request.tasks.length > 0 || (request.options.filter ?? []).length > 0, {
    message: 'name at least one task, or filter by labels',
    path: ['tasks'],
  })

export type RunRequest = z.infer<typeof runRequestSchema>
export type RunOptions = z.infer<typeof runOptionsSchema>
