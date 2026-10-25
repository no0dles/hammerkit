import { IncomingMessage, ServerResponse } from 'http'
import { z } from 'zod'
import { readJson, send } from './http'
import { Principal } from './oauth'
import { getGrant, mayReadChecks } from './policy'
import { ServerConfig } from './server-config'
import { CHECK_KEY_PATTERN, CheckRecord, CheckStore } from './checks'
import { normalizeRepo } from './repo'
import { DefinitionStore } from './definitions'

// the tasks one lookup may ask about
export const MAX_LOOKUP_KEYS = 100

const lookupSchema = z
  .object({
    repo: z.string().transform((value, ctx) => {
      const repo = normalizeRepo(value)
      if (!repo) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expected a repository like github.com/corp/payments' })
        return z.NEVER
      }
      return repo
    }),
    keys: z
      .array(
        z
          .object({
            task: z.string().min(1).max(200),
            key: z.string().regex(CHECK_KEY_PATTERN, 'expected a check key, 64 hex digits'),
          })
          .strict()
      )
      .min(1)
      .max(MAX_LOOKUP_KEYS),
  })
  .strict()

// What a caller is told of a passed check: no more than who ran it, where and when.
export type CheckView = Omit<CheckRecord, 'repo' | 'key'>

/**
 * What runs passed, for CI that verifies instead of running (`hammerkit remote verify`):
 *
 *   POST /v1/checks/lookup   { repo, keys: [{ task, key }] }  the newest passed run per key
 *
 * The caller computed the keys from its own checkout (check-key.ts); a key nothing passed
 * for, or whose version of the build file was yanked since, is answered with none.
 */
export async function handleChecks(
  config: ServerConfig,
  checks: CheckStore,
  definitions: DefinitionStore,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  if (url.pathname !== '/v1/checks/lookup') {
    return false
  }
  if (req.method !== 'POST') {
    send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    return true
  }
  const parsed = lookupSchema.safeParse(await readJson(req))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    send(res, 400, { error: `${issue.path.join('.') || 'request'}: ${issue.message}` })
    return true
  }
  const { repo, keys } = parsed.data
  const grant = getGrant(config.entitlements, principal)
  if (!mayReadChecks(grant, repo)) {
    log(`refuse checks iss=${principal.iss} sub=${principal.sub} repo=${repo}`)
    send(res, 403, { error: `you may not read the checks of ${repo}` })
    return true
  }
  const answers = await Promise.all(
    keys.map(async ({ task, key }) => {
      const record = await checks.find(repo, key)
      const yanked = record ? definitions.find(record.definition)?.yanked : undefined
      if (!record || yanked) {
        return {
          task,
          key,
          passed: null,
          ...(yanked ? { reason: `it passed with ${record?.definition}, which was yanked since` } : {}),
        }
      }
      const { repo: _repo, key: _key, ...view } = record
      void _repo
      void _key
      return { task, key, passed: view satisfies CheckView }
    })
  )
  log(
    `checks iss=${principal.iss} sub=${principal.sub} repo=${repo} passed=${answers.filter((a) => a.passed).length}/${
      answers.length
    }`
  )
  send(res, 200, { checks: answers })
  return true
}
