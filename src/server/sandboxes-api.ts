import { IncomingMessage, ServerResponse } from 'http'
import { z } from 'zod'
import { readJson, send } from './http'
import { Principal } from './oauth'
import { decideSandbox, getGrant, sandboxPushBranches, subjectName } from './policy'
import { normalizeRepo } from './repo'
import { RepoAccess } from './repo-access'
import { SANDBOX_ID_PATTERN } from './runs'
import { handleSandboxFiles, SandboxFileAction } from './sandbox-files-api'
import { Sandbox, SandboxError, SandboxRegistry } from './sandboxes'
import { ServerConfig } from './server-config'
import {
  answerPage,
  countValues,
  ListParamError,
  newestFirst,
  Page,
  pageByKey,
  PageRequest,
  parsePage,
  parseValues,
  readList,
} from './paging'

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
    // a branch: a sandbox never starts from a tag or a commit
    ref: refSchema,
  })
  .strict()

const fetchSchema = z.object({ ref: refSchema }).strict()

// trailers by which a person attests a commit, which a caller could otherwise put in another
// person's name
const ATTESTATION = /^\s*(signed-off-by|reviewed-by|acked-by|tested-by)\s*:/im

const pushSchema = z
  .object({
    branch: refSchema,
    // the message of the commit, as `git commit -m` takes it; it can not sign off for, or
    // claim the review of, anybody
    message: z
      .string()
      .trim()
      .min(1)
      .max(10_000)
      .refine(
        (message) => !ATTESTATION.test(message),
        'the message may not carry Signed-off-by, Reviewed-by, Acked-by or Tested-by: the server pushes as the caller'
      ),
  })
  .strict()

/**
 * The sandboxes of a caller: checkouts on the server that runs work on.
 *
 *   POST   /v1/sandboxes              { repo, ref }  fetch a branch into a new sandbox
 *   GET    /v1/sandboxes              the caller's sandboxes, their limits and usage;
 *                                     `?scope=all` everybody's, with `observe`; `owner`,
 *                                     `repo` and `ref` narrow them, `limit` and `cursor`
 *                                     page them the last used first, `values=<field>`
 *                                     answers the values of a filter (paging.ts)
 *   GET    /v1/sandboxes/<id>         one sandbox
 *   DELETE /v1/sandboxes/<id>         cancel its runs and remove it
 *   POST   /v1/sandboxes/<id>/fetch   { ref }  move a sandbox without changes to a branch's commit
 *   POST   /v1/sandboxes/<id>/push    { branch, message }  commit the changes and push them
 *   ...    /v1/sandboxes/<id>/tree, files/<path>, search, edits, changes: its files, see
 *          `handleSandboxFiles`
 *
 * A sandbox is its owner's: anybody else gets `404`. Who observes (`observe` on an
 * entitlement) may read every sandbox, as they read every run: list them, and get one, its
 * tree, files, search and changes. Everything that changes a sandbox or runs on it stays
 * its owner's, and is `404` to them too.
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
  const match = /^\/v1\/sandboxes(?:\/([^/]+)(?:\/(fetch|push|tree|search|edits|changes)|\/(files)\/(.+))?)?$/.exec(
    url.pathname
  )
  if (!match) {
    return false
  }
  const [, id, named, files, encodedPath] = match
  const action = named ?? files
  const method = req.method
  const who = `iss=${principal.iss} sub=${principal.sub}`
  const show = (sandbox: Sandbox) => view(config, sandboxes, principal, sandbox)
  try {
    if (!id) {
      if (method === 'GET') {
        const scope = url.searchParams.get('scope') ?? 'mine'
        if (scope !== 'mine' && scope !== 'all') {
          send(res, 400, { error: 'scope: mine or all' })
          return true
        }
        if (scope === 'all' && !getGrant(config.entitlements, principal).observe) {
          send(res, 403, { error: 'scope all needs an entitlement with observe' })
          return true
        }
        try {
          listSandboxes(config, sandboxes, principal, scope, url.searchParams, res, show)
        } catch (e) {
          if (!(e instanceof ListParamError)) {
            throw e
          }
          send(res, 400, { error: e.message })
        }
      } else if (method === 'POST') {
        const body = parse(createSchema, await readJson(req))
        const refused = decideSandbox(getGrant(config.entitlements, principal), body.repo, body.ref, (repo) =>
          repos.readable(repo)
        )
        if (refused) {
          log(`refuse sandbox ${who} repo=${body.repo}: ${refused.error}`)
          send(res, refused.status, { error: refused.error })
          return true
        }
        const sandbox = await sandboxes.create(principal, body.repo, body.ref)
        log(`sandbox create ${sandbox.id} ${who} repo=${sandbox.repo} commit=${sandbox.commit} bytes=${sandbox.bytes}`)
        send(res, 201, show(sandbox))
      } else {
        send(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' })
      }
      return true
    }
    const known = SANDBOX_ID_PATTERN.test(id)
    const own = known ? sandboxes.get(principal, id) : undefined
    const observes = getGrant(config.entitlements, principal).observe
    const reading = isRead(action, method)
    // who observes reads the sandbox of anybody; a change is for its owner, and else not found
    const sandbox = own ?? (known && observes && reading ? sandboxes.peek(id) : undefined)
    if (!sandbox) {
      send(res, 404, { error: 'not found' })
      return true
    }
    if (action && action !== 'fetch' && action !== 'push') {
      // the owner may have lost the repository, or the sandbox's branch, since they created
      // it; who observes reads it all the same
      const refused =
        own && !(observes && reading)
          ? decideSandbox(getGrant(config.entitlements, principal), sandbox.repo, sandbox.ref, (repo) =>
              repos.readable(repo)
            )
          : undefined
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
    if (action === 'fetch' || action === 'push') {
      if (method !== 'POST') {
        send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
        return true
      }
      const body = action === 'fetch' ? parse(fetchSchema, await readJson(req)) : parse(pushSchema, await readJson(req))
      // the caller may have lost the repository or the sandbox's branch since they created the
      // sandbox, and a fetch needs the new branch
      const grant = getGrant(config.entitlements, principal)
      const refused = decideSandbox(grant, sandbox.repo, 'ref' in body ? body.ref : sandbox.ref, (repo) =>
        repos.readable(repo)
      )
      if (refused) {
        log(`refuse sandbox ${action} ${id} ${who}: ${refused.error}`)
        send(res, refused.status, { error: refused.error })
        return true
      }
      if ('branch' in body) {
        const pushed = await sandboxes.push(
          principal,
          id,
          body.branch,
          { ...author(principal), message: body.message },
          sandboxPushBranches(grant, sandbox.repo)
        )
        log(`sandbox push ${id} ${who} branch=${body.branch} commit=${pushed.commit}`)
        send(res, 200, { branch: body.branch, commit: pushed.commit, sandbox: show(pushed) })
        return true
      }
      const fetched = await sandboxes.fetch(principal, id, body.ref)
      log(`sandbox fetch ${id} ${who} ref=${body.ref} commit=${fetched.commit}`)
      send(res, 200, show(fetched))
    } else if (method === 'GET') {
      send(res, 200, show(sandbox))
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

/**
 * Who the commit of a push is by: the caller, as their token names them (`name` and
 * `email`, unless the issuer says the address is not verified), else by their subject at the
 * host of their issuer. Without a name, the local part of the address names them, then the
 * subject. Never what the request says, so a commit can not claim to be
 * somebody else's.
 */
export function author(principal: Principal): { name: string; email: string } {
  const clean = (value: string | undefined) =>
    (value ?? '')
      .replace(/[<>\0\r\n]/g, '')
      .trim()
      .slice(0, 200)
  // an address the issuer says it did not verify is whatever the caller typed in
  const claimed = principal.emailVerified === false ? '' : clean(principal.claims.email)
  const email = /^[^\s@]+@[^\s@]+$/.test(claimed) ? claimed : ''
  // a Google service account's token has an address but no name: its local part reads better than the number in sub
  const name =
    clean(principal.claims.name) ||
    clean(principal.claims.preferred_username) ||
    email.slice(0, email.indexOf('@')) ||
    clean(principal.sub)
  if (email) {
    return { name, email }
  }
  let host = 'hammerkit'
  try {
    host = new URL(principal.iss).hostname || host
  } catch {
    // an issuer that is not a URL keeps the default
  }
  const local = principal.sub.replace(/[^A-Za-z0-9._+-]/g, '-').slice(0, 64) || 'sandbox'
  return { name, email: `${local}@${host}` }
}

/**
 * Whether a request only reads a sandbox, which who observes may: the sandbox, its tree, a
 * file, a search and its changes. Edits, a write of a file, a fetch, a push and a delete
 * change it.
 */
function isRead(action: string | undefined, method: string | undefined): boolean {
  switch (action) {
    case undefined:
      return method === 'GET'
    case 'tree':
    case 'changes':
      return method === 'GET'
    case 'files':
      return method === 'GET' || method === 'HEAD'
    case 'search':
      // ripgrep's query is a body
      return method === 'POST'
    default:
      return false
  }
}

// A sandbox as the caller sees it, and the run that holds it: their own without its owner,
// one of somebody else (who observes) with whose it is, as a run of somebody else names it.
function view(config: ServerConfig, sandboxes: SandboxRegistry, principal: Principal, sandbox: Sandbox) {
  const { owner, ...visible } = sandbox
  const run = sandboxes.holder(sandbox.id)
  const mine = owner.iss === principal.iss && owner.sub === principal.sub
  const name = owner.name ?? subjectName(config.entitlements, owner)
  return {
    ...visible,
    ...(mine ? {} : { owner: { iss: owner.iss, sub: owner.sub, ...(name ? { name } : {}) } }),
    busy: run !== undefined,
    run: run ?? null,
  }
}

// what the sandboxes page narrows by, and GET /v1/sandboxes?values= answers the values of
const SANDBOX_FIELDS = ['owner', 'repo', 'ref'] as const

// `owner` (the subject of whose it is), `repo` and `ref`, each repeated for more than one
type SandboxFilter = Partial<Record<(typeof SANDBOX_FIELDS)[number], string[]>>

function parseSandboxFilter(params: URLSearchParams): SandboxFilter {
  return Object.fromEntries(
    SANDBOX_FIELDS.map((field) => [field, readList(params, field)]).filter(([, values]) => values)
  )
}

function filterSandboxes(sandboxes: Sandbox[], filter: SandboxFilter): Sandbox[] {
  return sandboxes.filter(
    (sandbox) =>
      (!filter.owner || filter.owner.includes(sandbox.owner.sub)) &&
      (!filter.repo || filter.repo.includes(sandbox.repo)) &&
      (!filter.ref || filter.ref.includes(sandbox.ref))
  )
}

// the last used first, as the sandboxes page shows them
const sandboxKey = (sandbox: Sandbox): [string, string] => [sandbox.lastUsedAt, sandbox.id]

function pageOfSandboxes<T>(sandboxes: Sandbox[], page: PageRequest, show: (sandbox: Sandbox) => T): Page<T> {
  const answered = pageByKey(newestFirst(sandboxes, sandboxKey), page, sandboxKey)
  return { ...answered, items: answered.items.map(show) }
}

// GET /v1/sandboxes: the sandboxes of the scope that the filters let through, a page of them,
// or the values of a filter.
function listSandboxes<T>(
  config: ServerConfig,
  sandboxes: SandboxRegistry,
  principal: Principal,
  scope: 'mine' | 'all',
  params: URLSearchParams,
  res: ServerResponse,
  show: (sandbox: Sandbox) => T
): void {
  const filter = parseSandboxFilter(params)
  const values = parseValues(params, SANDBOX_FIELDS)
  const page = values ? undefined : parsePage(params)
  const listed = scope === 'all' ? sandboxes.all() : sandboxes.list(principal)
  const nameOf = (owner: Sandbox['owner']) => owner.name ?? subjectName(config.entitlements, owner)
  if (values) {
    // a value of the field is counted over the sandboxes the other filters let through
    const { field } = values
    const counted = countValues(
      filterSandboxes(listed, { ...filter, [field]: undefined }),
      (sandbox) => [field === 'owner' ? { value: sandbox.owner.sub, name: nameOf(sandbox.owner) } : sandbox[field]],
      values
    )
    send(res, 200, answerPage('values', counted))
    return
  }
  const found = filterSandboxes(listed, filter)
  const limits = sandboxes.limits
  // the limits and the usage are the caller's, whichever sandboxes they list
  send(res, 200, {
    ...(page ? answerPage('sandboxes', pageOfSandboxes(found, page, show)) : { sandboxes: found.map(show) }),
    limits: { count: limits.count, bytes: limits.bytes },
    used: sandboxes.usage(principal),
  })
}
