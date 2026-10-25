import { z } from 'zod'
import { parseDuration } from '../utils/units'
import { HASH_PATTERN } from '../remote/bundle'
import { normalizeRepo } from './repo'
import { SANDBOX_ID_PATTERN } from './runs'

const name = z.string().min(1).max(200)

// The name of a service run, one DNS label: the hosts of its endpoints carry it, and a run of
// the same caller with the same name replaces it
export const SERVICE_RUN_NAME_PATTERN = /^[a-z0-9]([a-z0-9-]{0,38}[a-z0-9])?$/

// endpoints one service run may publish
export const MAX_ENDPOINTS = 5

// what one run may pass after `--`
export const MAX_ARGS = 100
export const MAX_ARGS_BYTES = 16 * 1024

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
    // as the text after `--`: appended to the last command of the one task the run
    // names, each quoted for its shell. A task that reads a secret or a variable of the
    // server takes none (see refuseArguments).
    args: z
      .array(z.string().refine((arg) => !arg.includes('\0'), 'an argument can not contain a NUL character'))
      .max(MAX_ARGS)
      .refine(
        (args) => args.reduce((total, arg) => total + Buffer.byteLength(arg), 0) <= MAX_ARGS_BYTES,
        `the arguments are longer than ${MAX_ARGS_BYTES / 1024} KiB together`
      )
      .optional(),
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
          // the commit the ref has to be at, such as the one a CI job checked out: a ref that
          // moved since is refused, so the run executes the code that was asked for
          commit: z
            .string()
            .regex(/^([0-9a-f]{40}|[0-9a-f]{64})$/, 'expected a full commit hash, 40 or 64 hex digits')
            .optional(),
        })
        .strict(),
      // the name of a tree announced with POST /v1/sources
      z.object({ type: z.literal('upload'), snapshot: z.string().regex(HASH_PATTERN) }).strict(),
      // a sandbox of the caller's, see POST /v1/sandboxes
      z
        .object({ type: z.literal('sandbox'), id: z.string().regex(SANDBOX_ID_PATTERN, 'expected a sandbox id') })
        .strict(),
    ]),
    options: runOptionsSchema.default({}),
    // a service run: these services of the build file, started as `hammerkit up` starts
    // them and kept up until `ttl` ends or the run is cancelled, instead of tasks
    services: z.array(name).max(20).default([]),
    // how long the services stay up once they are ready; `runs.up.ttl` when left out
    ttl: duration.optional(),
    // a second service run of the caller with the same name replaces the first; the branch
    // of the source when left out
    name: z
      .string()
      .regex(SERVICE_RUN_NAME_PATTERN, 'expected lower case letters, digits and -, at most 40, as a DNS label')
      .optional(),
    // ports of the run's services published at hosts of their own, behind the server's sign-in
    endpoints: z
      .array(
        z
          .object({ service: name, port: z.number().int().min(1).max(65535) })
          .strict()
      )
      .max(MAX_ENDPOINTS)
      .default([]),
  })
  .strict()
  .refine(
    (request) =>
      request.services.length > 0 || request.tasks.length > 0 || (request.options.filter ?? []).length > 0,
    {
      message: 'name at least one task, or filter by labels',
      path: ['tasks'],
    }
  )
  .refine((request) => request.services.length === 0 || request.tasks.length === 0, {
    message: 'a run names tasks or services, not both',
    path: ['services'],
  })
  .refine(
    (request) =>
      request.services.length === 0 ||
      ((request.options.filter ?? []).length === 0 && (request.options.exclude ?? []).length === 0),
    { message: 'a service run names its services, labels do not select them', path: ['options', 'filter'] }
  )
  .refine((request) => request.services.length === 0 || (request.options.args ?? []).length === 0, {
    message: 'a service run takes no arguments',
    path: ['options', 'args'],
  })
  .refine(
    (request) =>
      request.services.length > 0 ||
      (request.ttl === undefined && request.name === undefined && request.endpoints.length === 0),
    { message: 'ttl, name and endpoints are for a run of services', path: ['services'] }
  )
  .refine(
    (request) =>
      new Set(request.endpoints.map((endpoint) => `${endpoint.service}:${endpoint.port}`)).size ===
      request.endpoints.length,
    { message: 'an endpoint is named twice', path: ['endpoints'] }
  )
  .refine((request) => (request.options.args ?? []).length === 0 || request.tasks.length === 1, {
    message: 'arguments go to one task, name exactly one in tasks',
    path: ['options', 'args'],
  })

export type RunRequest = z.infer<typeof runRequestSchema>
export type RunOptions = z.infer<typeof runOptionsSchema>
