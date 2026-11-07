import { IncomingMessage, ServerResponse } from 'http'
import { timingSafeEqual } from 'crypto'
import { readFile } from 'fs/promises'
import { join } from 'path'
import { send } from './http'
import { Principal } from './oauth'
import { getGrant, mayPublish } from './policy'
import { mayRead, maySee, seesActivity, Viewer } from './overview'
import { RunRegistry } from './runs'
import type { ServerConfig } from './server-config'

/**
 * The dashboard: a React app (dashboard/ in the repository, built into dist/dashboard) that
 * shows a person what `remote status`, `remote services`, `remote runs`, `remote tasks`,
 * `remote logs` and `remote approvals` print, with the buttons to stop and extend runs and
 * to decide about approvals.
 *
 * The app reads and does everything through the API, as the person who signed in: its host
 * passes `/api/v1/...` on to `/v1/...` of the API (server.ts handleApi) for the paths below,
 * and no other. So the rules of who sees what are those of the API, and the pages show what
 * the command line shows. What the app sends needs the token of `/api/session`, which is
 * bound to the sign-in; approving and rejecting need a sign-in of the last minutes.
 */
export interface DashboardContext {
  config: ServerConfig
  registry: RunRegistry
  // the API, for a caller who is known (server.ts handleApi)
  api: (principal: Principal, req: IncomingMessage, res: ServerResponse, url: URL) => Promise<void>
  // the built app: index.html and assets/; dist/dashboard next to the server's code by default
  assets?: string
  // signs the token of what the app sends, with the key of the sessions
  sign: (value: string) => string
  log: (line: string) => void
  now?: () => number
  // what the token is bound to: the sign-in (its session), or an API token
  session?: string
  // when the person signed in to the dashboard; left out for a caller with an API token
  signedInAt?: number
}

// What the app learns about who looks, from GET /api/session.
export interface DashboardSession {
  iss: string
  sub: string
  observe: boolean
  // sees the runs of others (observe, or runs.activity: everyone with a builds level)
  seesOthers: boolean
  // may publish build file versions: decides about proposals of others
  publishes: boolean
  // sent back in the `x-hammerkit-csrf` header of what the app sends
  csrf: string
  // until when this sign-in may approve and reject; left out for an API token, which may always
  decideUntil?: string
  decideWithinMinutes: number
}

// Approving and publishing take a sign-in of the last minutes: the groups of a session are
// those of its sign-in, and somebody taken out of a group must not decide for hours.
export const DECIDE_WITHIN_MS = 15 * 60_000

const RUN = 'run_[A-Za-z0-9_-]{16}'
// a hash of a build file version, checked by the API
const HASH = '[A-Za-z0-9:_-]{1,200}'
const path = (pattern: string) => new RegExp(`^/v1/${pattern}$`)

// what the pages read
const READS = [
  'me',
  'overview',
  'capacity',
  'tasks',
  'runs',
  `runs/${RUN}`,
  `runs/${RUN}/logs`,
  'approvals',
  `approvals/${RUN}`,
  'proposals',
  `proposals/${HASH}`,
  `proposals/${HASH}/files`,
].map(path)
// what the buttons do
const ACTIONS = [`runs/${RUN}/(cancel|extend)`].map(path)
// what needs a recent sign-in
const DECISIONS = [`approvals/${RUN}/(approve|reject)`, `proposals/${HASH}/(approve|reject)`].map(path)

export const HEADERS = {
  'cache-control': 'no-store',
  'x-robots-tag': 'noindex',
  // the app is a script and a style sheet of its own host, and talks to its host only
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; " +
    "font-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
}

const TYPES: Record<string, string> = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
}

export async function handleDashboard(
  context: DashboardContext,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const now = context.now ?? Date.now
  const grant = getGrant(context.config.entitlements, principal)
  const viewer: Viewer = { principal, grant, activity: context.config.runs.activity === 'everyone' }
  const pathname = url.pathname
  for (const [name, value] of Object.entries(HEADERS)) {
    res.setHeader(name, value)
  }
  if (pathname === '/api' || pathname.startsWith('/api/')) {
    if (grant.matched.length === 0) {
      return send(res, 403, { error: 'you are not entitled to anything on this server' })
    }
    return api(context, principal, viewer, now(), req, res, url)
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return send(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' })
  }
  return asset(context, req, res, pathname)
}

async function api(
  context: DashboardContext,
  principal: Principal,
  viewer: Viewer,
  now: number,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<void> {
  const { grant } = viewer
  const csrf = context.sign(`dashboard\0csrf\0${principal.iss}\0${principal.sub}\0${context.session ?? 'token'}`)
  const method = req.method ?? 'GET'
  if (url.pathname === '/api/session') {
    if (method !== 'GET') {
      return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    }
    const session: DashboardSession = {
      iss: principal.iss,
      sub: principal.sub,
      observe: grant.observe,
      seesOthers: grant.observe || seesActivity(viewer),
      publishes: mayPublish(grant),
      csrf,
      ...(context.signedInAt !== undefined
        ? { decideUntil: new Date(context.signedInAt + DECIDE_WITHIN_MS).toISOString() }
        : {}),
      decideWithinMinutes: DECIDE_WITHIN_MS / 60_000,
    }
    return send(res, 200, session)
  }
  const download = new RegExp(`^/api/runs/(${RUN})/log\\.txt$`).exec(url.pathname)
  if (download) {
    if (method !== 'GET') {
      return send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
    }
    return logText(context, viewer, res, download[1], url.searchParams.get('task') ?? undefined)
  }
  const target = url.pathname.slice('/api'.length)
  const read = READS.some((pattern) => pattern.test(target))
  const action = ACTIONS.some((pattern) => pattern.test(target))
  const decision = DECISIONS.some((pattern) => pattern.test(target))
  if (!read && !action && !decision) {
    return send(res, 404, { error: 'not found' })
  }
  if (method === 'GET' || method === 'HEAD') {
    if (!read) {
      return send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
    }
  } else if (method === 'POST' && (action || decision)) {
    // a page of another site can not set the header, nor read the token
    const given = Buffer.from(String(req.headers['x-hammerkit-csrf'] ?? ''))
    const expected = Buffer.from(csrf)
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      return send(res, 403, { error: 'the page is out of date, open it again' })
    }
    // an API token is new; a sign-in in the browser has to be of the last minutes to decide
    if (decision && context.signedInAt !== undefined && now - context.signedInAt > DECIDE_WITHIN_MS) {
      return send(res, 403, {
        error: `approving and rejecting take a sign-in of the last ${DECIDE_WITHIN_MS / 60_000} minutes`,
        signInAgain: true,
      })
    }
    context.log(`dashboard ${method} ${target} iss=${principal.iss} sub=${principal.sub}`)
  } else {
    return send(res, 405, { error: 'method not allowed' }, { allow: read ? 'GET' : 'POST' })
  }
  const forwarded = new URL(`${target}${url.search}`, 'http://localhost')
  return context.api(principal, req, res, forwarded)
}

// The log as a text file: what the tasks printed, as they printed it.
function logText(
  context: DashboardContext,
  viewer: Viewer,
  res: ServerResponse,
  id: string,
  task: string | undefined
): void {
  const run = context.registry.peek(id)
  // the log is for the owner of the run, who decides about it and observe
  const logs = run && maySee(viewer, run) && mayRead(viewer, run) ? context.registry.logsOf(id) : undefined
  if (!run || !logs) {
    return send(res, 404, { error: 'not found' })
  }
  const names = logs.index.names()
  const chosen = task !== undefined && names.includes(task) ? task : undefined
  const lines: string[] = []
  const selected = chosen ? logs.index.lines(chosen) : undefined
  const total = selected ? selected.length : logs.index.size
  for (let position = 0; position < total; position++) {
    const line = logs.index.text(logs.events, selected ? selected[position] : position)
    lines.push(chosen ? line.text : `[${line.task}] ${line.text}`)
  }
  if (logs.truncated) {
    lines.push('[hammerkit] the log was cut off at runs.maxLogBytes')
  }
  res.writeHead(200, {
    'content-type': 'text/plain; charset=utf-8',
    'content-disposition': `attachment; filename="${run.id}${
      chosen ? `-${chosen.replace(/[^A-Za-z0-9._-]/g, '_')}` : ''
    }.log"`,
  })
  res.end(lines.join('\n') + (lines.length > 0 ? '\n' : ''))
}

// The files of the app: its scripts and styles by their hashed names, and index.html for
// every page, which the app draws.
async function asset(context: DashboardContext, req: IncomingMessage, res: ServerResponse, pathname: string) {
  const root = context.assets ?? join(__dirname, '..', 'dashboard')
  const file = /^\/assets\/[A-Za-z0-9_-][A-Za-z0-9._-]{0,200}$/.test(pathname)
    ? pathname.slice(1)
    : pathname === '/favicon.svg'
      ? 'favicon.svg'
      : pathname.startsWith('/assets/') || pathname.startsWith('/.')
        ? undefined
        : 'index.html'
  if (!file) {
    return send(res, 404, { error: 'not found' })
  }
  let content: Buffer
  try {
    content = await readFile(join(root, file))
  } catch {
    if (file === 'index.html') {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
      res.end('The dashboard of this server was not built (npm run build:dashboard).\n')
      return
    }
    return send(res, 404, { error: 'not found' })
  }
  const extension = /\.[a-z0-9]+$/.exec(file)?.[0] ?? ''
  res.writeHead(200, {
    'content-type': file === 'index.html' ? 'text/html; charset=utf-8' : TYPES[extension] ?? 'application/octet-stream',
    // the names of the scripts and styles change with what they hold
    ...(file.startsWith('assets/') ? { 'cache-control': 'public, max-age=31536000, immutable' } : {}),
  })
  res.end(req.method === 'HEAD' ? undefined : content)
}
