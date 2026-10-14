import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from 'http'
import { createServer as createHttpsServer } from 'https'
import { AddressInfo } from 'net'
import { Environment } from '../executer/environment'
import { getVersion } from '../version'
import { detectPlatform, getSandboxRuntimes, getSecretCatalog, getSourceAccounts, ServerConfig } from './server-config'
import { DiscoveryDocument, DISCOVERY_PATH, SERVER_PROTOCOL } from './discovery'
import { Principal, quote, TokenError, TokenVerifier, TokenVerifierOptions } from './oauth'
import { canUse, decideRun, getGrant, mayRun } from './policy'
import { FileRunStore } from './run-store'
import { isFinal, RUN_ID_PATTERN, RunError, RunExecutor, Run, RunRegistry, RunSource, StoredEvent } from './runs'
import { RefError } from './git-checkout'
import { RepoAccess, RepoAccessOptions } from './repo-access'
import { HostExecutor } from './executor'
import { KubernetesExecutor } from './kubernetes-backend'
import { PlanContext, PlannedRun, planRun, refuseArguments } from './run-plan'
import { parseWorkNetwork } from '../planner/work-network'
import { runEnvironment } from './run-environment'
import { handleAccounts } from './accounts-api'
import { runRequestSchema } from './run-request'
import { HttpError, readJson, send } from './http'
import { DefinitionStore } from './definitions'
import { handleDefinitions } from './definitions-api'
import { handleApprovals } from './approvals-api'
import { handleProposals } from './proposals-api'
import { ProposalRegistry } from './proposals'
import { SourceStore } from './sources'
import { handleSources } from './sources-api'
import { Sandbox, SandboxError, SandboxRegistry } from './sandboxes'
import { HostSandboxStorage } from './sandbox-storage'
import { KubernetesSandboxStorage } from './kubernetes-sandbox-storage'
import { DockerSandboxContainers } from './sandbox-docker'
import { handleSandboxes } from './sandboxes-api'
import { PlanPolicy } from './plan'
import { formatDuration, parseDuration, parseSize } from '../utils/units'
import { parseLogQuery, readLogs } from './run-logs'
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
    backend:
      config.backend.type === 'kubernetes'
        ? {
            type: 'kubernetes',
            platform: config.backend.pools[0].platform,
            pools: config.backend.pools.map((pool) => ({ name: pool.name, platform: pool.platform })),
          }
        : { type: 'host', platform: config.backend.platform ?? detectPlatform() },
  }
}

export interface ReloadResult {
  // the keys of the new config that differ and need a restart to take effect
  restart: string[]
}

export interface RunningServer {
  url: string
  close(): Promise<void>
  /**
   * Takes over the entitlements of a new config, for the next request. Nothing else is
   * reloaded: the accounts, issuers, providers and sources are in use by runs, and a
   * changed one is reported in `restart`. Throws, and keeps the entitlements, when
   * the new ones name an account or an issuer this server does not have.
   */
  reload(next: ServerConfig): ReloadResult
}

export interface ServerOptions extends TokenVerifierOptions {
  // one line per decision about a caller, for the operator
  log?: (line: string) => void
  // carries out the runs; without one, runs are accepted and fail with a reason
  executor?: RunExecutor
  // the command that starts the process of a run; `hammerkit server-run` of this build by default
  worker?: string[]
  // how repositories are located and resolved, for tests
  repos?: RepoAccessOptions
}

const HEARTBEAT_MS = 15_000

// the longest `?wait=` of a run: below the 60 seconds after which a proxy in front of the
// server (nginx by default) closes a connection that says nothing
const MAX_WAIT_MS = 50_000

// Server-sent events: `id` is the sequence number, so a client that lost the
// connection continues with Last-Event-ID (or ?after=) and misses nothing.
function streamEvents(
  registry: RunRegistry,
  config: ServerConfig,
  principal: Principal,
  id: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): void {
  const after = Number(req.headers['last-event-id'] ?? url.searchParams.get('after') ?? 0)
  const write = (event: StoredEvent) =>
    res.write(`id: ${event.seq}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  const watch = registry.watch(
    principal,
    id,
    Number.isFinite(after) && after > 0 ? after : 0,
    (event) => {
      write(event)
      if (event.type === 'state' && isFinal(event.state)) {
        end()
      }
    },
    accountsOf(config, principal)
  )
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

// What a run on a sandbox is checked against: the sandboxes, and the runtimes they allow.
interface SandboxContext {
  registry: SandboxRegistry
  policy: PlanPolicy
}

async function handleRuns(
  config: ServerConfig,
  registry: RunRegistry,
  definitions: DefinitionStore,
  sources: SourceStore,
  sandboxes: SandboxContext,
  planning: PlanContext,
  repos: RepoAccess,
  log: (line: string) => void,
  principal: Principal,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): Promise<boolean> {
  const match = /^\/v1\/runs(?:\/([^/]+)(?:\/(cancel|events|logs))?)?$/.exec(url.pathname)
  if (!match) {
    return false
  }
  const [, id, action] = match
  const method = req.method
  if (!id) {
    if (method === 'GET') {
      // the results of each task are read one run at a time
      send(res, 200, {
        runs: registry.list(principal).map((run) => {
          const { results, ...listed } = toRunResponse(run)
          void results
          return listed
        }),
      })
    } else if (method === 'POST') {
      await submitRun(config, registry, definitions, sources, sandboxes, planning, repos, log, principal, req, res)
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
    const run = registry.cancel(principal, id, accountsOf(config, principal))
    log(`cancel iss=${principal.iss} sub=${principal.sub} run=${id} found=${Boolean(run)}`)
    run ? send(res, 200, toRunResponse(run)) : send(res, 404, { error: 'not found' })
  } else if (method !== 'GET') {
    send(res, 405, { error: 'method not allowed' }, { allow: 'GET' })
  } else if (action === 'events') {
    streamEvents(registry, config, principal, id, req, res, url)
  } else if (action === 'logs') {
    let query
    try {
      query = parseLogQuery(url.searchParams)
    } catch (e) {
      send(res, 400, { error: e instanceof Error ? e.message : String(e) })
      return true
    }
    const logs = registry.logs(principal, id, accountsOf(config, principal))
    logs
      ? send(res, 200, readLogs(logs.events, logs.index, query, logs.truncated))
      : send(res, 404, { error: 'not found' })
  } else {
    let wait = 0
    const waitParam = url.searchParams.get('wait')
    if (waitParam !== null) {
      try {
        wait = Math.min(parseDuration(waitParam), MAX_WAIT_MS)
      } catch {
        send(res, 400, { error: `wait is a duration up to ${formatDuration(MAX_WAIT_MS)}, for example 30s` })
        return true
      }
    }
    // a caller that hangs up stops waiting
    const gone = new AbortController()
    res.on('close', () => gone.abort())
    const run = await registry.wait(principal, id, wait, accountsOf(config, principal), gone.signal)
    if (!gone.signal.aborted) {
      run ? send(res, 200, toRunResponse(run)) : send(res, 404, { error: 'not found' })
    }
  }
  return true
}

// The accounts the caller uses: who approves a run on them follows and stops it.
function accountsOf(config: ServerConfig, principal: Principal): (account: string) => boolean {
  const grant = getGrant(config.entitlements, principal)
  return (account) => canUse(grant, account)
}

function toRunResponse(run: Run): Omit<Run, 'owner'> {
  const { owner, ...visible } = run
  void owner
  return { ...visible, results: run.results ?? {} }
}

async function submitRun(
  config: ServerConfig,
  registry: RunRegistry,
  definitions: DefinitionStore,
  sources: SourceStore,
  sandboxes: SandboxContext,
  planning: PlanContext,
  repos: RepoAccess,
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
  // what the caller may not do is said plainly: they already know who they are
  if (!mayRun(grant)) {
    log(`refuse run iss=${principal.iss} sub=${principal.sub}: no entitlement`)
    send(res, 403, { error: 'you are not entitled to run anything on this server' })
    return
  }
  const version = definitions.find(request.definition.name, request.definition.hash)
  if (!version) {
    send(res, 400, { error: `there is no build file ${request.definition.name} at ${request.definition.hash}` })
    return
  }
  if (version.yanked) {
    send(res, 409, {
      error: `${version.name} at ${version.hash} was yanked${
        version.yanked.reason ? `: ${version.yanked.reason}` : ''
      }`,
    })
    return
  }
  const known = [...version.tasks, ...version.services]
  const unknown = request.tasks.filter((task) => !known.includes(task))
  if (unknown.length > 0) {
    send(res, 400, { error: `${version.name} has no task ${unknown.map(quote).join(', ')}` })
    return
  }
  const argued = (request.options.args ?? []).length > 0 ? request.tasks[0] : undefined
  if (argued !== undefined && version.services.includes(argued)) {
    send(res, 400, { error: `${argued} is a service, arguments go to a task` })
    return
  }
  if (request.source.type === 'upload') {
    // a run starts from files the server has all of, never from a half-sent tree
    const tree = await sources.get(principal, request.source.snapshot)
    if (!tree) {
      send(res, 400, {
        error: `the files ${request.source.snapshot} are not known, announce them with POST /v1/sources`,
      })
      return
    }
    if (tree.missing.length > 0) {
      send(res, 400, {
        error: `the files ${tree.snapshot} are not complete, ${tree.missing.length} of them still have to be sent`,
      })
      return
    }
  }
  const sandbox = request.source.type === 'sandbox' ? sandboxes.registry.get(principal, request.source.id) : undefined
  if (request.source.type === 'sandbox') {
    if (!sandbox) {
      send(res, 400, { error: `there is no sandbox ${request.source.id}, create one with POST /v1/sandboxes` })
      return
    }
    if (sandboxes.policy.runtimes?.length === 0) {
      send(res, 403, {
        error: 'this server runs only local tasks, which it runs on no sandbox unless sandboxes.runtimes names local',
      })
      return
    }
    const over = sandboxes.registry.overLimit(principal)
    if (over) {
      send(res, 413, { error: over })
      return
    }
  }
  // the accounts of a run are read from the files it is pinned to, with the engine
  const bundle = version.plan ? await definitions.files(version) : undefined
  if (!version.plan || !bundle) {
    send(res, 409, {
      error: `${version.name} at ${version.hash} was published before accounts were recorded, publish it again`,
    })
    return
  }
  let planned: PlannedRun
  try {
    // a run on a sandbox may only use the runtimes of `sandboxes.runtimes`
    planned = await planRun(bundle, request, planning.environment, sandbox ? sandboxes.policy : planning.policy)
  } catch (e) {
    send(res, 400, { error: `the run does not load: ${e instanceof Error ? e.message : String(e)}` })
    return
  }
  const refused = refuseArguments(request, planned.plan)
  if (refused) {
    log(`refuse run iss=${principal.iss} sub=${principal.sub}: ${refused}`)
    send(res, 400, { error: refused })
    return
  }
  const decision = decideRun({
    grant,
    accounts: planned.accounts,
    catalog: config.accounts,
    source:
      request.source.type === 'ref'
        ? { type: 'ref', repo: request.source.repo, ref: request.source.ref }
        : sandbox
          ? { type: 'sandbox', repo: sandbox.repo, branch: sandbox.ref }
          : { type: 'upload' },
    approvable: (account) => config.entitlements.some((entitlement) => entitlement.accounts[account] === 'use'),
    readable: (repo) => repos.readable(repo),
  })
  if (decision.type === 'refuse') {
    log(`refuse run iss=${principal.iss} sub=${principal.sub}: ${decision.error}`)
    send(res, decision.status, { error: decision.error })
    return
  }
  const approvals = decision.type === 'approval' ? decision.accounts : []
  // the ref is pinned now: the approver sees the commit, and the run executes that one
  let source: RunSource | undefined
  if (request.source.type === 'ref') {
    try {
      const commit = await repos.resolve(request.source.repo, request.source.ref)
      source = { type: 'ref', repo: request.source.repo, ref: request.source.ref, commit }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log(`refuse run iss=${principal.iss} sub=${principal.sub}: ${message}`)
      send(res, e instanceof RefError ? 400 : 502, {
        error: e instanceof RefError ? message : `could not resolve ${request.source.ref}: ${message}`,
      })
      return
    }
  } else if (request.source.type === 'upload') {
    source = request.source
  }
  const submit = (runSource: RunSource) =>
    registry.submit(
      principal,
      {
        definition: { name: version.name, hash: version.hash },
        tasks: request.tasks,
        accounts: planned.accounts,
        plan: planned.plan,
        source: runSource,
        options: request.options,
      },
      approvals
    )
  try {
    // a sandbox is read and the run submitted while nothing else changes it: the run
    // records what the sandbox held, and holds it from now on
    const run = source
      ? submit(source)
      : await sandboxes.registry.withSandbox(principal, (sandbox as Sandbox).id, async (current) => {
          const state = await sandboxes.registry.state(current.id)
          return submit({
            type: 'sandbox',
            id: current.id,
            repo: current.repo,
            commit: state.commit,
            tree: state.tree,
            clean: state.clean,
          })
        })
    log(
      `run ${run.id} iss=${principal.iss} sub=${principal.sub} accounts=[${planned.accounts.join(',')}] source=${
        run.source.type
      }${run.source.type === 'sandbox' ? ` sandbox=${run.source.id}` : ''} tasks=${run.tasks.length}${
        approvals.length > 0 ? ` approval=[${approvals.join(',')}]` : ''
      }`
    )
    send(res, 202, toRunResponse(run))
  } catch (e) {
    if (e instanceof RunError) {
      send(res, e.status, { error: e.message })
      return
    }
    if (e instanceof SandboxError) {
      send(res, e.status === 404 ? 400 : e.status, {
        error: e.status === 404 ? `there is no sandbox ${(sandbox as Sandbox).id}` : e.message,
      })
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
  proposals: ProposalRegistry,
  sources: SourceStore,
  sandboxes: SandboxContext,
  planning: PlanContext,
  repos: RepoAccess,
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

  if (await handleAccounts(config, log, principal, req, res, url)) {
    return
  }
  if (await handleDefinitions(config, definitions, proposals, log, principal, req, res, url)) {
    return
  }
  if (await handleSources(config, sources, log, principal, req, res, url)) {
    return
  }
  if (await handleSandboxes(config, sandboxes.registry, repos, log, principal, req, res, url)) {
    return
  }
  if (
    await handleRuns(config, registry, definitions, sources, sandboxes, planning, repos, log, principal, req, res, url)
  ) {
    return
  }
  if (await handleApprovals(config, registry, log, principal, req, res, url)) {
    return
  }
  if (await handleProposals(config, definitions, proposals, log, principal, req, res, url)) {
    return
  }
  send(res, 404, { error: 'not found' })
}

export async function startServer(
  config: ServerConfig,
  environment: Environment,
  options: ServerOptions = {}
): Promise<RunningServer> {
  // tasks find their tools through PATH, a server that hides it would fail every run
  if (!config.runs.env.allow.some((name) => name.toUpperCase() === 'PATH') && !('PATH' in config.runs.env.set)) {
    throw new Error(
      'runs.env.allow has no PATH, tasks could not find their tools: add PATH (and on Windows SystemRoot, ComSpec, PATHEXT and TEMP)'
    )
  }
  const verifier = new TokenVerifier(config.issuers, options)
  const write = options.log ?? (() => undefined)
  // request urls and subjects come from callers: no control characters, so no forged log lines
  const log = (line: string) => write(line.replace(/\p{Cc}/gu, '?').slice(0, 1000))
  if (config.runtimes.includes('local') && config.backend.type === 'host') {
    log(
      'warning: the local runtime is allowed, local tasks run as the user of this server and read all it can read; ' +
        'an account is then an approval class, not a credential boundary'
    )
  }
  // build files are read, planned and run as the server's runs see the world: the
  // operator's accounts and the allowlisted environment, nothing of the server's own
  const planning: PlanContext = {
    environment: {
      ...environment,
      processEnvs: runEnvironment(config, environment.processEnvs),
      hosted: { catalog: getSecretCatalog(config) },
    },
    policy: {
      envs: config.runs.env.allow,
      reserved: getSourceAccounts(config),
      runtimes: config.runtimes,
      backend: config.backend.type,
      network: parseWorkNetwork(config.runs.network),
    },
  }
  const storage = config.storage.directory ?? join(getHammerkitDirectory(), 'server')
  const definitions = new DefinitionStore(join(storage, 'definitions'), planning.environment, {
    policy: planning.policy,
  })
  await definitions.load()
  const repos = new RepoAccess(config, planning.environment, options.repos)
  const sandboxRuntimes = getSandboxRuntimes(config)
  const sandboxLimits = {
    count: config.sandboxes.limits.count,
    bytes: parseSize(config.sandboxes.limits.bytes),
    total: parseSize(config.sandboxes.total),
  }
  const sandboxes: SandboxContext = {
    registry: new SandboxRegistry({
      // on a cluster a claim per sandbox in the caller's namespace, else a directory
      storage:
        config.backend.type === 'kubernetes'
          ? new KubernetesSandboxStorage(
              { ...config, backend: config.backend },
              sandboxLimits,
              planning.environment.processEnvs,
              join(storage, 'sandboxes', 'staging')
            )
          : new HostSandboxStorage(
              join(storage, 'sandboxes', 'files'),
              planning.environment.processEnvs,
              // what containers of runs leave behind is given back and removed with a container
              sandboxRuntimes.includes('docker')
                ? new DockerSandboxContainers(planning.environment.processEnvs.DOCKER_HOST)
                : undefined
            ),
      records: join(storage, 'sandboxes', 'records'),
      limits: sandboxLimits,
      repos,
      log,
    }),
    // a sandbox holds code nobody reviewed: only the variables of `sandboxes.env`
    policy: {
      ...planning.policy,
      envs: config.sandboxes.env.allow,
      envsFrom: 'sandboxes.env.allow',
      runtimes: sandboxRuntimes,
    },
  }
  if (sandboxRuntimes.length === 0 && config.entitlements.some((entitlement) => entitlement.sandboxes?.length)) {
    log(
      'warning: entitlements keep sandboxes, but this server runs only local tasks, which it runs on no sandbox; ' +
        'runs on sandboxes are refused until sandboxes.runtimes names a runtime'
    )
  }
  // on a cluster that lists the claims of sandboxes in the namespaces of callers, which a
  // server without sandboxes need not be allowed to
  if (config.backend.type === 'host' || config.entitlements.some((entitlement) => entitlement.sandboxes?.length)) {
    await sandboxes.registry.load()
  }
  const executorOptions = {
    definitions,
    planning,
    repos,
    directory: join(storage, 'runs'),
    cache: join(storage, 'cache'),
    worker: options.worker,
    sandboxes: { ...sandboxes, network: config.sandboxes.network },
  }
  const backend = config.backend
  const executor =
    options.executor ??
    (backend.type === 'kubernetes'
      ? new KubernetesExecutor({ ...config, backend }, environment.processEnvs, executorOptions)
      : new HostExecutor(executorOptions))
  const sources = new SourceStore(join(storage, 'sources'))
  const registry = new RunRegistry({
    executor,
    maxConcurrent: config.runs.maxConcurrent,
    keep: config.runs.keep,
    maxWaiting: config.approvals.maxWaiting,
    approvalTimeout: parseDuration(config.approvals.timeout),
    limits: config.runs.limits,
    maxDuration: parseDuration(config.runs.maxDuration),
    maxLogBytes: config.runs.maxLogBytes,
    store: new FileRunStore(join(storage, 'records')),
    log,
  })
  await registry.restore()
  sandboxes.registry.useRuns({
    holder: (id) => registry.holder(id),
    stop: (id) => registry.stopSandbox(id, 'the sandbox was deleted'),
  })
  const proposals = new ProposalRegistry({
    maxWaiting: config.approvals.maxWaiting,
    timeout: parseDuration(config.approvals.timeout),
    cooldown: parseDuration(config.approvals.cooldown),
  })
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(
      config,
      registry,
      definitions,
      proposals,
      sources,
      sandboxes,
      planning,
      repos,
      verifier,
      log,
      req,
      res
    ).catch((e) => {
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
    reload: (next) => {
      const readers = getSourceAccounts(config)
      next.entitlements.forEach((entitlement, index) => {
        const iss = (entitlement.subject ?? entitlement.group ?? entitlement.claims)?.iss
        if (iss && !config.issuers.some((issuer) => issuer.issuer === iss)) {
          throw new Error(`entitlements.${index}: issuer ${iss} is not accepted by the running server`)
        }
        for (const account of Object.keys(entitlement.accounts)) {
          if (!config.accounts[account] || readers.includes(account)) {
            throw new Error(`entitlements.${index}: the running server has no account ${account} to give`)
          }
        }
      })
      const restart = Object.keys(next).filter(
        (key) =>
          key !== 'entitlements' &&
          JSON.stringify(next[key as keyof ServerConfig]) !== JSON.stringify(config[key as keyof ServerConfig])
      )
      // every request reads the entitlements of this object
      config.entitlements = next.entitlements
      log(
        `reloaded ${next.entitlements.length} entitlements${
          restart.length > 0 ? `, restart for: ${restart.join(', ')}` : ''
        }`
      )
      return { restart }
    },
    close: async () => {
      proposals.close()
      await registry.close()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      })
    },
  }
}
