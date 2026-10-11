import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from 'http'
import { createServer as createHttpsServer } from 'https'
import { AddressInfo } from 'net'
import { Environment } from '../executer/environment'
import { getVersion } from '../version'
import { detectPlatform, ServerConfig } from './server-config'
import { DiscoveryDocument, DISCOVERY_PATH, SERVER_PROTOCOL } from './discovery'
import { Principal, quote, TokenError, TokenVerifier, TokenVerifierOptions } from './oauth'
import { getGrant, maySeeDefinitions } from './policy'
import {
  isFinal,
  RUN_ID_PATTERN,
  RunError,
  RunExecutor,
  Run,
  RunRegistry,
  StoredEvent,
  unavailableExecutor,
} from './runs'
import { runRequestSchema } from './run-request'
import { HttpError, readJson, send } from './http'
import { DefinitionStore } from './definitions'
import { handleDefinitions } from './definitions-api'
import { handleApprovals } from './approvals-api'
import { parseDuration } from '../utils/units'
import { getHammerkitDirectory } from '../optimizer/get-cache-directory'
import { join } from 'path'

export { DISCOVERY_PATH, SERVER_PROTOCOL } from './discovery'
export type { DiscoveredIssuer, DiscoveryDocument } from './discovery'

export function getDiscoveryDocument(config: ServerConfig): DiscoveryDocument {
  return {
    name: 'hammerkit',
    version: getVersion(),
    protocol: SERVER_PROTOCOL,
    issuers: config.issuers.map((i) => ({
      issuer: i.issuer,
      audience: i.audience,
      ...(i.clientId ? { clientId: i.clientId } : {}),
      scope: i.scope,
    })),
    backend: { type: config.backend.type, platform: config.backend.platform ?? detectPlatform() },
  }
}

export interface RunningServer {
  url: string
  close(): Promise<void>
}

export interface ServerOptions extends TokenVerifierOptions {
  // one line per decision about a caller, for the operator
  log?: (line: string) => void
  // carries out the runs; without one, runs are accepted and fail with a reason
  executor?: RunExecutor
}

const HEARTBEAT_MS = 15_000

// Server-sent events: `id` is the sequence number, so a client that lost the
// connection continues with Last-Event-ID (or ?after=) and misses nothing.
function streamEvents(
  registry: RunRegistry,
  principal: Principal,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): void {
  const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0)
  const write = (event: StoredEvent) =>
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  const watch = registry.watch(principal, id, Number.isFinite(after) && after > 0 ? after : 0, (event) => {
    write(event)
    if (event.type === 'state' && isFinal(event.state)) {
      end()
    }
  })
  if (!watch) {
    send(res, 404, { error: 'not found' })
    return
  }
  const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), HEARTBEAT_MS)
  const end = () => {
    clearInterval(heartbeat)
    watch.stop()
    res.end()
  }
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
  watch.events.forEach(write)
  if (watch.finished) {
    end()
    return
  }
  res.on('close', () => {
    clearInterval(heartbeat)
    watch.stop()
  })
}

async function handleRuns(
  config: ServerConfig,
  registry: RunRegistry,
  definitions: DefinitionStore,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = /^\/v1\/runs(?:\/([^/]+)(?:\/(cancel|events))?)?$/.exec(url.pathname)
  if (!match) {
    return false
  }
  const [, id, action] = match
  const method = req.method
  if (!id) {
    if (method === 'GET') {
      send(res, 200, { runs: registry.list(principal).map(toRunResponse) })
    } else if (method === 'POST') {
      await submitRun(config, registry, definitions, log, principal, req, res)
    } else {
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET, POST' })
    }
    return true
  }
  if (!RUN_ID_PATTERN.test(id)) {
    send(res, 404, { error: 'not found' })
  } else if (action === 'cancel') {
    if (method !== 'POST') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'POST' })
      return true
    }
    const run = registry.cancel(principal, id)
    log(`cancel iss=${principal.iss} sub=${principal.sub} run=${id} found=${Boolean(run)}`)
    run ? send(res, 200, toRunResponse(run)) : send(res, 404, { error: 'not found' })
  } else if (method !== 'GET') {
    send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
  } else if (action === 'events') {
    streamEvents(registry, principal, id, req, res, url)
  } else {
    const run = registry.get(principal, id)
    run ? send(res, 200, toRunResponse(run)) : send(res, 404, { error: 'not found' })
  }
  return true
}

function toRunResponse(run: Run): Omit<Run, 'owner'> {
  const { owner, ...visible } = run
  void owner
  return visible
}

async function submitRun(
  config: ServerConfig,
  registry: RunRegistry,
  definitions: DefinitionStore,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const parsed = runRequestSchema.safeParse(await readJson(req))
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    send(res, 400, { error: `${issue.path.join('.') || 'request'}: ${issue.message}` })
    return
  }
  const request = parsed.data
  const grant = getGrant(config.entitlements, principal)
  const account = request.account ?? grant.default
  // what the caller may not do is said plainly: they already know who they are
  if (account !== null && !grant.accounts.includes(account) && !grant.request.includes(account)) {
    log(`refuse run iss=${principal.iss} sub=${principal.sub}: service account ${quote(account)} is not granted`)
    send(res, 403, { error: `you may not use the service account ${account}` })
    return
  }
  if (!grant.source.includes(request.source.type)) {
    log(`refuse run iss=${principal.iss} sub=${principal.sub}: source ${request.source.type} is not granted`)
    send(res, 403, { error: `runs from ${request.source.type} are not allowed for you` })
    return
  }
  if (!maySeeDefinitions(grant)) {
    log(`refuse run iss=${principal.iss} sub=${principal.sub}: no entitlement`)
    send(res, 403, { error: 'you are not entitled to run anything on this server' })
    return
  }
  const version = definitions.find(request.definition.name, request.definition.hash)
  if (!version) {
    send(res, 400, { error: `there is no build file ${request.definition.name} at ${request.definition.hash}` })
    return
  }
  const known = [...version.tasks, ...version.services]
  const unknown = request.tasks.filter((task) => !known.includes(task))
  if (unknown.length > 0) {
    send(res, 400, { error: `${version.name} has no task ${unknown.map(quote).join(', ')}` })
    return
  }
  // asking for an account is not using it: an admin of it has to approve
  const needsApproval = account !== null && !grant.accounts.includes(account)
  try {
    const run = registry.submit(
      principal,
      {
        definition: { name: version.name, hash: version.hash },
        tasks: request.tasks,
        account,
        source: request.source,
        options: request.options,
      },
      needsApproval
    )
    log(
      `run ${run.id} iss=${principal.iss} sub=${principal.sub} account=${account ?? '-'} source=${
        run.source.type
      } tasks=${run.tasks.length}${needsApproval ? ' approval=required' : ''}`
    )
    send(res, 202, toRunResponse(run))
  } catch (e) {
    if (e instanceof RunError) {
      send(res, 503, { error: e.message })
      return
    }
    throw e
  }
}

function bearerToken(req: IncomingMessage): string | null {
  const match = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(req.headers.authorization ?? '')
  return match ? match[1] : null
}

// Callers are known by their validated token alone. The reason a token was
// refused goes to the log, the caller only learns that it was.
async function authenticate(
  verifier: TokenVerifier,
  log: (line: string) => void,
  req: IncomingMessage,
  res: ServerResponse
): Promise<Principal | null> {
  const token = bearerToken(req)
  try {
    if (!token) {
      throw new TokenError('no bearer token')
    }
    return await verifier.verify(token)
  } catch (e) {
    log(`deny ${req.method} ${req.url}: ${e instanceof TokenError ? e.message : 'token could not be checked'}`)
    send(res, 401, { error: 'invalid token' }, { 'www-authenticate': 'Bearer error="invalid_token"' })
    return null
  }
}

async function handle(
  config: ServerConfig,
  registry: RunRegistry,
  definitions: DefinitionStore,
  verifier: TokenVerifier,
  log: (line: string) => void,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const path = url.pathname
  if (path === DISCOVERY_PATH || path === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' })
      return
    }
    send(res, 200, path === '/healthz' ? { status: 'ok' } : getDiscoveryDocument(config))
    return
  }

  const principal = await authenticate(verifier, log, req, res)
  if (!principal) {
    return
  }

  if (path === '/v1/me' && req.method === 'GET') {
    const grant = getGrant(config.entitlements, principal)
    log(
      `grant iss=${principal.iss} sub=${principal.sub} accounts=[${grant.accounts.join(
        ','
      )}] entitlements=[${grant.matched.join(',')}]`
    )
    send(res, 200, {
      iss: principal.iss,
      sub: principal.sub,
      accounts: grant.accounts,
      default: grant.default,
      request: grant.request,
      publish: grant.publish,
    })
    return
  }
  if (await handleDefinitions(config, definitions, log, principal, req, res, url)) {
    return
  }
  if (await handleRuns(config, registry, definitions, log, principal, req, res, url)) {
    return
  }
  if (await handleApprovals(config, registry, log, principal, req, res, url)) {
    return
  }
  send(res, 404, { error: 'not found' })
}

export async function startServer(
  config: ServerConfig,
  environment: Environment,
  options: ServerOptions = {}
): Promise<RunningServer> {
  const verifier = new TokenVerifier(config.issuers, options)
  const write = options.log ?? (() => undefined)
  // request urls and subjects come from callers: no control characters, so no forged log lines
  const log = (line: string) => write(line.replace(/\p{Cc}/gu, '?').slice(0, 1000))
  const definitions = new DefinitionStore(
    join(config.storage.directory ?? join(getHammerkitDirectory(), 'server'), 'definitions'),
    environment
  )
  await definitions.load()
  const registry = new RunRegistry({
    executor: options.executor ?? unavailableExecutor,
    maxConcurrent: config.runs.maxConcurrent,
    keep: config.runs.keep,
    maxWaiting: config.approvals.maxWaiting,
    approvalTimeout: parseDuration(config.approvals.timeout),
  })
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(config, registry, definitions, verifier, log, req, res).catch((e) => {
      if (e instanceof HttpError) {
        send(res, e.status, { error: e.message })
        return
      }
      log(`error ${req.method} ${req.url}: ${e instanceof Error ? e.message : String(e)}`)
      if (!res.headersSent) {
        send(res, 500, { error: 'internal error' })
      } else {
        res.end()
      }
    })
  }
  let server: Server
  if (config.tls) {
    const [cert, key] = await Promise.all([
      environment.file.read(config.tls.cert),
      environment.file.read(config.tls.key),
    ])
    server = createHttpsServer({ cert, key }, listener)
  } else {
    server = createHttpServer(listener)
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.listen.port, config.listen.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const address = server.address() as AddressInfo
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address
  return {
    url: `${config.tls ? 'https' : 'http'}://${host}:${address.port}`,
    close: async () => {
      await registry.close()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}
