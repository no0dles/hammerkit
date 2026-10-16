import { z } from 'zod'
import { parseDuration } from '../utils/units'
import { HASH_PATTERN } from '../remote/bundle'
import { normalizeRepo } from './repo'

const name = z.string().min(1).max(200)

// What `POST /v1/runs` takes. Who is asking and which accounts they may use is
// decided from the token, never from this body; the accounts a run uses are those
// its secrets are read as, which the server derives from the published build file.
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
    // the published version of the build file to run, by its hash
    definition: z.string().regex(HASH_PATTERN, 'expected the hash of a published build file, sha256:...'),
    // tasks by their name in the build file, as on the command line; labels in
    // the options can select tasks instead
    tasks: z.array(name).max(100).default([]),
    source: z.discriminatedUnion('type', [
      z
        .object({
          type: z.literal('ref'),
          // `host/path`, such as github.com/corp/payments; the server reads it from its own
          // sources, a url is never taken from a request
          repo: z.string().transform((value, ctx) => {
            const repo = normalizeRepo(value)
            if (!repo) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: 'expected a repository like github.com/corp/payments',
              })
              return z.NEVER
            }
            return repo
          }),
          ref: name,
        })
        .strict(),
      // the name of a tree announced with POST /v1/sources
      z.object({ type: z.literal('upload'), snapshot: z.string().regex(HASH_PATTERN) }).strict(),
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
