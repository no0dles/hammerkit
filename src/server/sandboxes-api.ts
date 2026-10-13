import { IncomingMessage, ServerResponse } from 'http'
import { z } from 'zod'
import { readJson, send } from './http'
import { Principal } from './oauth'
import { decideSandbox, getGrant } from './policy'
import { normalizeRepo } from './repo'
import { RepoAccess } from './repo-access'
import { SANDBOX_ID_PATTERN } from './runs'
import { handleSandboxFiles, SandboxFileAction } from './sandbox-files-api'
import { Sandbox, SandboxError, SandboxRegistry } from './sandboxes'
import { ServerConfig } from './server-config'

const refSchema = z.string().min(1).max(200)

const createSchema = z
  .object({
    // `host/path`, as a ref run names it
    repo: z.string().transform((value, ctx) => {
      const repo = normalizeRepo(value)
      if (!repo) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'expected a repository like github.com/corp/payments' })
        return z.NEVER
      }
      return repo
    }),
    ref: refSchema,
  })
  .strict()

const fetchSchema = z.object({ ref: refSchema }).strict()

/**
 * The sandboxes of a caller: checkouts on the server that runs work on.
 *
 *   POST   /v1/sandboxes              { repo, ref }  fetch a ref into a new sandbox
 *   GET    /v1/sandboxes              the caller's sandboxes, their limits and usage
 *   GET    /v1/sandboxes/<id>         one sandbox
 *   DELETE /v1/sandboxes/<id>         cancel its runs and remove it
 *   POST   /v1/sandboxes/<id>/fetch   { ref }  move a sandbox without changes to another commit
 *   ...    /v1/sandboxes/<id>/tree, files/<path>, search, edits, changes: its files, see
 *          `handleSandboxFiles`
 *
 * A sandbox is its owner's: anybody else gets `404`.
 */
export async function handleSandboxes(
  config: ServerConfig,
  sandboxes: SandboxRegistry,
  repos: Pick<RepoAccess, 'readable'>,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = /^\/v1\/sandboxes(?:\/([^/]+)(?:\/(fetch|tree|search|edits|changes)|\/(files)\/(.+))?)?$/.exec(
    url.pathname
  )
  if (!match) {
    return false
  }
  const [, id, named, files, encodedPath] = match
  const action = named ?? files
  const method = req.method
  const who = `iss=${principal.iss} sub=${principal.sub}`
  try {
    if (!id) {
      if (method === 'GET') {
        const limits = sandboxes.limits
        send(res, 200, {
          sandboxes: sandboxes.list(principal).map((sandbox) => view(sandboxes, sandbox)),
          limits: { count: limits.count, bytes: limits.bytes },
          used: sandboxes.usage(principal),
        })
      } else if (method === 'POST') {
        const body = parse(createSchema, await readJson(req))
        if (config.backend.type !== 'host') {
          send(res, 501, { error: 'this server keeps sandboxes only on a host backend' })
          return true
        }
        const refused = decideSandbox(getGrant(config.entitlements, principal), body.repo, (repo) =>
          repos.readable(repo)
        )
        if (refused) {
          log(`refuse sandbox ${who} repo=${body.repo}: ${refused.error}`)
          send(res, refused.status, { error: refused.error })
          return true
        }
        const sandbox = await sandboxes.create(principal, body.repo, body.ref)
        log(`sandbox create ${sandbox.id} ${who} repo=${sandbox.repo} commit=${sandbox.commit} bytes=${sandbox.bytes}`)
        send(res, 201, view(sandboxes, sandbox))
      } else {
        send(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' })
      }
      return true
    }
    const sandbox = SANDBOX_ID_PATTERN.test(id) ? sandboxes.get(principal, id) : undefined
    if (!sandbox) {
      send(res, 404, { error: 'not found' })
      return true
    }
    if (action && action !== 'fetch') {
      // the caller may have lost the repository since they created the sandbox
      const refused = decideSandbox(getGrant(config.entitlements, principal), sandbox.repo, (repo) =>
        repos.readable(repo)
      )
      if (refused) {
        log(`refuse sandbox ${action} ${id} ${who}: ${refused.error}`)
        send(res, refused.status, { error: refused.error })
        return true
      }
      let path: string | undefined
      try {
        path = encodedPath === undefined ? undefined : decodeURIComponent(encodedPath)
      } catch {
        send(res, 400, { error: 'the path is not valid percent-encoding' })
        return true
      }
      await handleSandboxFiles(sandboxes, log, principal, sandbox, action as SandboxFileAction, path, req, res, url)
      return true
    }
    if (action === 'fetch') {
      if (method !== 'POST') {
        send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
        return true
      }
      const body = parse(fetchSchema, await readJson(req))
      // the caller may have lost the repository since they created the sandbox
      const refused = decideSandbox(getGrant(config.entitlements, principal), sandbox.repo, (repo) =>
        repos.readable(repo)
      )
      if (refused) {
        log(`refuse sandbox fetch ${id} ${who}: ${refused.error}`)
        send(res, refused.status, { error: refused.error })
        return true
      }
      const fetched = await sandboxes.fetch(principal, id, body.ref)
      log(`sandbox fetch ${id} ${who} ref=${body.ref} commit=${fetched.commit}`)
      send(res, 200, view(sandboxes, fetched))
    } else if (method === 'GET') {
      send(res, 200, view(sandboxes, sandbox))
    } else if (method === 'DELETE') {
      // a caller who lost the entitlement can still delete what they keep
      const removed = await sandboxes.remove(principal, id)
      log(`sandbox delete ${id} ${who} found=${removed}`)
      removed ? send(res, 200, { deleted: id }) : send(res, 404, { error: 'not found' })
    } else {
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET, DELETE' })
    }
  } catch (e) {
    if (e instanceof SandboxError) {
      log(`refuse sandbox ${id ?? 'create'} ${who}: ${e.message}`)
      send(res, e.status, { error: e.message })
      return true
    }
    throw e
  }
  return true
}

function parse<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, body: unknown): T {
  const parsed = schema.safeParse(body)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new SandboxError(400, `${issue.path.join('.') || 'request'}: ${issue.message}`)
  }
  return parsed.data
}

// What the owner sees: everything but the owner, and the run that holds it.
function view(sandboxes: SandboxRegistry, sandbox: Sandbox) {
  const { owner, ...visible } = sandbox
  void owner
  const run = sandboxes.holder(sandbox.id)
  return { ...visible, busy: run !== undefined, run: run ?? null }
}
