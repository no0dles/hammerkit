import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { IncomingHttpHeaders, IncomingMessage, request as httpRequest, ServerResponse } from 'http'
import { connect, Socket } from 'net'
import { dirname } from 'path'
import { Duplex } from 'stream'
import { Principal, TokenError, TokenVerifier } from './oauth'
import { getGrant } from './policy'
import { mayOpenEndpoints } from './service-runs'
import type { ServerConfig } from './server-config'
import type { EndpointTarget, Run, RunEndpoint, RunRegistry } from './runs'
import { formatDuration, parseDuration } from '../utils/units'
import { DashboardContext, handleDashboard } from './dashboard'

// The cookie of a sign-in at one endpoint host. `__Host-` keeps a page on another host of the
// domain from setting or overwriting it; it needs https, so plain http (on the loopback
// interface, for testing) goes without the prefix.
const SESSION_COOKIE = '__Host-hammerkit-session'
const PLAIN_SESSION_COOKIE = 'hammerkit-session'
// The cookie of a sign-in under way, on the login host, one per sign-in (by its state): the
// browser keeps what the callback needs, so a caller who is not signed in fills no table of
// the server's.
const LOGIN_COOKIE = '__Host-hammerkit-login-'
const PLAIN_LOGIN_COOKIE = 'hammerkit-login-'
// The cookie of the endpoint host that a sign-in started from, which the one-time code that
// comes back has to match: a code is for the browser that asked for it, not one it is sent to.
const BIND_COOKIE = '__Host-hammerkit-bind-'
const PLAIN_BIND_COOKIE = 'hammerkit-bind-'
// the most of the page to go back to that a sign-in keeps: its cookie stays below what a
// browser takes (4096 bytes for name and value)
const MAX_RETURN_PATH = 1024
// the host of the domain that signs people in, the one redirect URI registered at the issuer
export const LOGIN_HOST = 'login'
// the paths of an endpoint host that are the server's, never the app's
const OWN_PATH = '/.hammerkit/'
// how long a sign-in may take at the issuer, and how long its one-time code holds
const LOGIN_TIMEOUT_MS = 10 * 60 * 1000
const CODE_TIMEOUT_MS = 60 * 1000
// the states of sign-ins that came back, so one is taken once; the oldest goes first when
// there are more, then only the issuer's one-time code holds
const MAX_SPENT_LOGINS = 10_000
const DISCOVERY_TTL_MS = 10 * 60 * 1000
const FETCH_TIMEOUT_MS = 10_000

export interface EndpointGatewayOptions {
  // where the key that signs sessions is kept, so a restart keeps them
  keyFile: string
  // the server's verifier of API tokens, for `Hammerkit-Authorization`
  verifier: TokenVerifier
  // reads the client secret of the sign-in, as the server's own account
  clientSecret?: () => Promise<string>
  log: (line: string) => void
  fetch?: typeof fetch
  now?: () => number
  // why the owner of a run that sleeps may no longer run it, which a wake checks
  mayWake?: (run: Run) => string | undefined
  // the API the dashboard reads and does what it shows through, and where its app is
  dashboard?: Pick<DashboardContext, 'api' | 'assets'>
}

interface Session {
  host: string
  iss: string
  sub: string
  groups: string[]
  claims: Record<string, string>
  exp: number
  // when the person signed in, for what needs a recent sign-in (deciding on the dashboard)
  at?: number
}

interface PendingLogin {
  state: string
  bind: string
  host: string
  path: string
  verifier: string
  nonce: string
  expires: number
}

interface IssuedCode {
  bind: string
  host: string
  path: string
  principal: Principal
  expires: number
}

/**
 * Publishes the endpoints of service runs: every host `<label>.<domain>` is answered here
 * and nowhere else. A caller is known by a session cookie of that host, which the sign-in
 * at `login.<domain>` gives a person, or by a token in `Hammerkit-Authorization`. Who may
 * open it (the run's owner, or an `open` level for its repository) is decided with the
 * entitlements of the moment on every request, then the request goes to the service's port.
 */
export class EndpointGateway {
  private key?: Buffer
  // the state of each sign-in that came back, until it would have expired
  private readonly spent = new Map<string, number>()
  private readonly codes = new Map<string, IssuedCode>()
  private readonly loginVerifier?: TokenVerifier
  private readonly fetcher: typeof fetch
  private readonly now: () => number
  private discovery?: { at: number; authorize: string; token: string }
  private base = { scheme: 'https', port: '' }

  constructor(
    private readonly config: ServerConfig,
    private readonly registry: RunRegistry,
    private readonly options: EndpointGatewayOptions
  ) {
    this.fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    const login = config.endpoints?.login
    const issuer = login ? config.issuers.find((candidate) => candidate.issuer === login.issuer) : undefined
    if (login && issuer) {
      // an ID token is meant for the client that signed in, not for the API
      this.loginVerifier = new TokenVerifier([{ ...issuer, audience: login.clientId }], {
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.now ? { now: options.now } : {}),
      })
    }
  }

  async load(): Promise<void> {
    try {
      const key = await readFile(this.options.keyFile)
      if (key.length >= 32) {
        this.key = key
        return
      }
    } catch {
      // made below
    }
    this.key = randomBytes(32)
    await mkdir(dirname(this.options.keyFile), { recursive: true, mode: 0o700 })
    await writeFile(this.options.keyFile, this.key, { mode: 0o600 })
  }

  // Where the server listens, for the addresses of endpoints: https unless it serves plain
  // http on the loopback interface; no port behind a proxy or on the default one.
  listening(port: number, secure: boolean): void {
    const scheme = secure || this.config.behindTlsProxy ? 'https' : 'http'
    const standard = this.config.behindTlsProxy || (scheme === 'https' ? port === 443 : port === 80)
    this.base = { scheme, port: standard ? '' : `:${port}` }
  }

  url(host: string, path = '/'): string {
    return `${this.base.scheme}://${host}.${this.config.endpoints?.domain}${this.base.port}${path}`
  }

  // The label of an endpoint host the request is for, or null when it is for the API.
  hostOf(req: IncomingMessage): string | null {
    const domain = this.config.endpoints?.domain
    const host = (req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '')
    if (!domain || !host.endsWith(`.${domain}`)) {
      return null
    }
    return host.slice(0, -domain.length - 1)
  }

  async handle(label: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://endpoint')
    if (label === LOGIN_HOST) {
      return this.handleLogin(req, res, url)
    }
    const found = /^[a-z0-9-]+$/.test(label) ? this.registry.endpoint(label) : undefined
    if (url.pathname === `${OWN_PATH}session`) {
      return this.takeCode(label, req, res, url)
    }
    if (url.pathname === `${OWN_PATH}logout`) {
      res.writeHead(303, { location: '/', 'set-cookie': this.clearCookie(), 'cache-control': 'no-store' })
      res.end()
      return
    }
    if (label === this.dashboardLabel() && url.pathname === `${OWN_PATH}signin`) {
      // sign in again, with the groups and claims of now, and go back to a page of the dashboard
      const back = url.searchParams.get('path') ?? '/'
      const path = /^\/[A-Za-z0-9_\-/?=&.,]*$/.test(back) && !back.startsWith('//') ? back : '/'
      return this.signIn(label, req, res, new URL(path, 'http://endpoint'))
    }
    if (label === this.dashboardLabel()) {
      const principal = await this.caller(label, req)
      if (!principal) {
        return this.signIn(label, req, res, url)
      }
      const dashboard = this.options.dashboard
      if (!dashboard) {
        return page(res, 404, 'Not found', '<p>This server has no dashboard.</p>')
      }
      // the token of what the app sends holds for this sign-in only: it dies with its session
      const session = this.readSession(label, req.headers.cookie)
      return handleDashboard(
        {
          config: this.config,
          registry: this.registry,
          sign: (value) => this.sign(value),
          log: this.options.log,
          ...(this.options.now ? { now: this.options.now } : {}),
          ...dashboard,
          session: session ? `session:${session.exp}` : 'token',
          // a cookie of before the sign-in time was kept counts as an old sign-in
          ...(session ? { signedInAt: session.at ?? 0 } : {}),
        },
        principal,
        req,
        res,
        url
      )
    }
    if (!found) {
      return page(res, 404, 'Not found', '<p>There is no endpoint at this address.</p>')
    }
    const principal = await this.caller(label, req)
    if (!principal) {
      return this.signIn(label, req, res, url)
    }
    if (!this.mayOpen(principal, found.run)) {
      this.options.log(`deny endpoint ${label} iss=${principal.iss} sub=${principal.sub}`)
      return page(
        res,
        403,
        'Not allowed',
        `<p>You are signed in as <code>${escape(principal.sub)}</code> of <code>${escape(
          principal.iss
        )}</code>, which may not open this endpoint.</p><p><a href="${OWN_PATH}logout">Sign out</a></p>`
      )
    }
    if (url.pathname === `${OWN_PATH}status` || url.pathname === `${OWN_PATH}extend`) {
      return this.status(label, found.run, found.endpoint, principal, req, res, url)
    }
    if (url.pathname.startsWith(OWN_PATH)) {
      return page(res, 404, 'Not found', '<p>There is no such page.</p>')
    }
    // a request keeps the services up, or wakes them
    const refused = this.registry.visit(found.run.id, this.options.mayWake)
    if (!found.target) {
      return this.notUp(res, this.registry.endpoint(label)?.run ?? found.run, refused)
    }
    this.forward(found.target, principal, req, res)
  }

  // A WebSocket (or any upgrade) to an endpoint, after the same checks as a request.
  async upgrade(label: string, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const refuse = (status: number, text: string) => {
      socket.end(`HTTP/1.1 ${status} ${text}\r\nconnection: close\r\ncontent-length: 0\r\n\r\n`)
    }
    const found = label !== LOGIN_HOST && /^[a-z0-9-]+$/.test(label) ? this.registry.endpoint(label) : undefined
    if (!found) {
      return refuse(404, 'Not Found')
    }
    const principal = await this.caller(label, req)
    if (!principal) {
      return refuse(401, 'Unauthorized')
    }
    if (!this.mayOpen(principal, found.run)) {
      this.options.log(`deny endpoint ${label} iss=${principal.iss} sub=${principal.sub}`)
      return refuse(403, 'Forbidden')
    }
    if (new URL(req.url ?? '/', 'http://endpoint').pathname.startsWith(OWN_PATH)) {
      return refuse(404, 'Not Found')
    }
    this.registry.visit(found.run.id, this.options.mayWake)
    const target = found.target
    if (!target) {
      return refuse(503, 'Service Unavailable')
    }
    const upstream: Socket = connect(target.address.port, target.address.host)
    const headers = this.forwardedHeaders(req, principal)
    upstream.once('connect', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`]
      for (const [name, value] of Object.entries(headers)) {
        for (const item of Array.isArray(value) ? value : [value]) {
          if (item !== undefined) {
            lines.push(`${name}: ${item}`)
          }
        }
      }
      upstream.write(`${lines.join('\r\n')}\r\n\r\n`)
      if (head.length > 0) {
        upstream.write(head)
      }
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  }

  // The host of the dashboard, when there is one: it needs the sign-in of a browser.
  dashboardLabel(): string | undefined {
    const label = this.config.endpoints?.dashboard
    return label && this.loginVerifier ? label : undefined
  }

  // The address of the dashboard, for a browser that opens the address of the API.
  dashboardUrl(): string | undefined {
    const label = this.dashboardLabel()
    return label ? this.url(label, '/') : undefined
  }

  // A person in a browser is sent to sign in, anything else is told how to.
  private signIn(label: string, req: IncomingMessage, res: ServerResponse, url: URL): void {
    if (this.loginVerifier && req.method === 'GET' && acceptsHtml(req.headers) && isPageLoad(req.headers)) {
      const bind = randomBytes(18).toString('base64url')
      const start = new URL(this.url(LOGIN_HOST, '/start'))
      start.searchParams.set('host', label)
      start.searchParams.set('path', url.pathname + url.search)
      start.searchParams.set('bind', bind)
      res.writeHead(302, {
        location: start.toString(),
        'set-cookie': this.cookie(this.bindCookieName(bind), bind, LOGIN_TIMEOUT_MS),
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    res.writeHead(401, {
      'content-type': 'text/plain; charset=utf-8',
      'www-authenticate': 'Bearer realm="hammerkit"',
      'cache-control': 'no-store',
    })
    res.end('sign in: send a token in Hammerkit-Authorization: Bearer <token>\n')
  }

  // Who may come back from the sign-in to a host: to an endpoint who may open it, to the
  // dashboard anybody with an entitlement.
  private mayEnter(principal: Principal, host: string): boolean {
    if (host === this.dashboardLabel()) {
      return getGrant(this.config.entitlements, principal).matched.length > 0
    }
    const found = this.registry.endpoint(host)
    return !!found && this.mayOpen(principal, found.run)
  }

  // The owner of the run, or who has an `open` level for its repository, with the
  // entitlements as they are now.
  private mayOpen(principal: Principal, run: Run): boolean {
    if (run.owner.iss === principal.iss && run.owner.sub === principal.sub) {
      return true
    }
    return mayOpenEndpoints(getGrant(this.config.entitlements, principal), run)
  }

  private async caller(label: string, req: IncomingMessage): Promise<Principal | null> {
    const header = req.headers['hammerkit-authorization']
    const token = typeof header === 'string' ? /^Bearer ([A-Za-z0-9._~+/-]+=*)$/.exec(header)?.[1] : undefined
    if (token) {
      try {
        return await this.options.verifier.verify(token)
      } catch (e) {
        this.options.log(
          `deny endpoint ${label}: ${e instanceof TokenError ? e.message : 'token could not be checked'}`
        )
        return null
      }
    }
    // the cookie is sent along when a page of another endpoint asks: the endpoints share
    // one site, and the app of one is not to act as its visitor on another
    if (this.fromElsewhere(label, req)) {
      return null
    }
    const session = this.readSession(label, req.headers.cookie)
    return session ? { iss: session.iss, sub: session.sub, groups: session.groups, claims: session.claims } : null
  }

  // Whether the browser sends the request for another page than the endpoint's own: an
  // upgrade from another origin, or a request a page of another site makes (a frame too),
  // but a link followed to the endpoint. Without Sec-Fetch-Site, by its Origin.
  private fromElsewhere(label: string, req: IncomingMessage): boolean {
    const origin = req.headers.origin
    const own = this.url(label, '/').slice(0, -1)
    if (req.headers.upgrade) {
      return origin !== own
    }
    const site = req.headers['sec-fetch-site']
    if (site === 'same-site' || site === 'cross-site') {
      // a page of its own the person goes to, not one framed by another site
      const dest = req.headers['sec-fetch-dest']
      return !(
        req.headers['sec-fetch-mode'] === 'navigate' &&
        (dest === undefined || dest === 'document') &&
        (req.method === 'GET' || req.method === 'HEAD')
      )
    }
    return site === undefined && origin !== undefined && origin !== own
  }

  private forward(target: EndpointTarget, principal: Principal, req: IncomingMessage, res: ServerResponse): void {
    const upstream = httpRequest(
      {
        host: target.address.host,
        port: target.address.port,
        method: req.method,
        path: req.url,
        headers: this.forwardedHeaders(req, principal),
      },
      (answer) => {
        const headers = { ...answer.headers, 'x-robots-tag': 'noindex' }
        res.writeHead(answer.statusCode ?? 502, answer.statusMessage, headers)
        answer.pipe(res)
      }
    )
    upstream.on('error', (e) => {
      this.options.log(`endpoint ${target.service}:${target.port}: ${e.message}`)
      if (!res.headersSent) {
        page(res, 502, 'Not reachable', `<p>${escape(target.service)} did not answer on port ${target.port}.</p>`)
      } else {
        res.destroy()
      }
    })
    res.on('close', () => upstream.destroy())
    req.pipe(upstream)
  }

  // What reaches the app: the request without the server's cookie and headers, with who asked.
  private forwardedHeaders(req: IncomingMessage, principal: Principal): IncomingHttpHeaders {
    const headers: IncomingHttpHeaders = {}
    for (const [name, value] of Object.entries(req.headers)) {
      if (name.startsWith('hammerkit-') || name.startsWith('x-hammerkit-') || name.startsWith('x-forwarded-')) {
        continue
      }
      headers[name] = value
    }
    const cookies = (req.headers.cookie ?? '')
      .split(/;\s*/)
      .filter(
        (cookie) => cookie && !cookie.startsWith(`${SESSION_COOKIE}=`) && !cookie.startsWith(`${PLAIN_SESSION_COOKIE}=`)
      )
    if (cookies.length > 0) {
      headers.cookie = cookies.join('; ')
    } else {
      delete headers.cookie
    }
    headers['x-forwarded-proto'] = this.base.scheme
    headers['x-forwarded-host'] = req.headers.host ?? ''
    headers['x-forwarded-for'] = req.socket.remoteAddress ?? ''
    headers['x-hammerkit-caller'] = `${principal.iss} ${principal.sub}`
    return headers
  }

  private notUp(res: ServerResponse, run: Run, refused?: string): void {
    if (run.state === 'queued' || run.state === 'running' || run.state === 'awaiting-approval') {
      res.setHeader('refresh', '5')
      res.setHeader('retry-after', '5')
      return page(
        res,
        503,
        'Starting',
        `<p>The services of this endpoint are ${run.wakes ? 'waking up' : 'starting'} (${escape(
          run.state
        )}), this page reloads until they are up.</p>`
      )
    }
    if (run.state === 'asleep') {
      // it may wake on a later request, once there is a place for it
      res.setHeader('refresh', '30')
      res.setHeader('retry-after', '30')
      return page(
        res,
        503,
        'Asleep',
        `<p>The services of this endpoint sleep and can not wake now: ${escape(refused ?? 'try again')}.</p>`
      )
    }
    const why =
      run.stoppedBy === 'ttl'
        ? 'its time ran out'
        : run.stoppedBy === 'replaced'
          ? 'a newer run of the same name replaced it'
          : run.stoppedBy
            ? `${escape(run.stoppedBy.sub)} stopped it`
            : escape(run.error ?? run.state)
    return page(
      res,
      410,
      'Ended',
      `<p>This endpoint ended${run.finishedAt ? ` at ${escape(run.finishedAt)}` : ''}: ${why}.</p><p>Ask <code>${escape(
        run.owner.sub
      )}</code> to start it again.</p>`
    )
  }

  private async status(
    label: string,
    run: Run,
    endpoint: RunEndpoint,
    principal: Principal,
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> {
    const csrf = this.sign(`csrf\0${label}\0${principal.iss}\0${principal.sub}`)
    if (url.pathname === `${OWN_PATH}extend`) {
      if (req.method !== 'POST') {
        return page(res, 405, 'Not allowed', '<p>Extend with the form of the status page.</p>')
      }
      const form = new URLSearchParams(await readText(req, 4096))
      if (!safeEqual(form.get('csrf') ?? '', csrf)) {
        return page(res, 403, 'Not allowed', '<p>The form is out of date, open the status page again.</p>')
      }
      let ttl: number
      try {
        ttl = parseDuration(form.get('ttl') ?? '')
        if (!(ttl > 0)) {
          throw new Error('no time')
        }
      } catch {
        return page(res, 400, 'Not a duration', '<p>Pick how long it should stay.</p>')
      }
      const result = this.registry.extend(principal, run.id, ttl, () => this.mayOpen(principal, run))
      this.options.log(`extend iss=${principal.iss} sub=${principal.sub} run=${run.id} result=${result.status}`)
      res.writeHead(303, { location: `${OWN_PATH}status`, 'cache-control': 'no-store' })
      res.end()
      return
    }
    const source =
      run.source.type === 'ref'
        ? `${run.source.repo} ${run.source.ref} at ${run.source.commit.slice(0, 12)}`
        : run.source.type === 'sandbox'
          ? `sandbox ${run.source.id} of ${run.source.repo} at ${run.source.commit.slice(0, 12)}${
              run.source.clean === false ? ' with changes' : ''
            }`
          : 'an upload'
    const options = ['1h', '8h', '24h', '72h']
      .map((ttl) => `<option value="${ttl}"${ttl === '8h' ? ' selected' : ''}>${ttl}</option>`)
      .join('')
    return page(
      res,
      200,
      run.up?.name ?? 'Endpoint',
      `<dl>
<dt>Service</dt><dd>${escape(endpoint.service)}, port ${endpoint.port}</dd>
<dt>Run</dt><dd><code>${escape(run.id)}</code> of <code>${escape(run.owner.sub)}</code>, ${escape(run.state)}</dd>
<dt>Source</dt><dd>${escape(source)}</dd>
<dt>Ends</dt><dd>${escape(run.expiresAt ?? 'when it is up and its time ran out')}</dd>
${
  run.up?.sleepTtl
    ? `<dt>Sleeps</dt><dd>after ${escape(formatDuration(run.up.sleepTtl))} without a request${
        run.sleepsAt ? `, next at ${escape(run.sleepsAt)}` : ''
      }; a request wakes it</dd>\n`
    : ''
}<dt>Signed in</dt><dd><code>${escape(principal.sub)}</code></dd>
</dl>
${
  run.state === 'up'
    ? `<form method="post" action="${OWN_PATH}extend"><input type="hidden" name="csrf" value="${csrf}"><label>Keep it for <select name="ttl">${options}</select> from now</label> <button>Extend</button></form>`
    : ''
}
<p><a href="/">Open the app</a> · <a href="${OWN_PATH}logout">Sign out</a></p>`
    )
  }

  // ---- sign-in, on login.<domain> ----

  private async handleLogin(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const login = this.config.endpoints?.login
    if (!login || !this.loginVerifier || req.method !== 'GET') {
      return page(res, 404, 'Not found', '<p>There is nothing here.</p>')
    }
    if (url.pathname === '/start') {
      const host = url.searchParams.get('host') ?? ''
      const path = url.searchParams.get('path') ?? '/'
      const bind = url.searchParams.get('bind') ?? ''
      if (
        !/^[a-z0-9-]+$/.test(host) ||
        host === LOGIN_HOST ||
        (host !== this.dashboardLabel() && !this.registry.endpoint(host))
      ) {
        return page(res, 404, 'Not found', '<p>There is no endpoint at this address.</p>')
      }
      if (!BIND_PATTERN.test(bind)) {
        return page(res, 400, 'Not signed in', '<p>Open the endpoint to sign in.</p>')
      }
      // a sign-in starts when a person goes to it, not from a request of a page, which could
      // pile up cookies of sign-ins in their browser
      if (req.headers['sec-fetch-mode'] !== undefined && req.headers['sec-fetch-mode'] !== 'navigate') {
        return page(res, 403, 'Not allowed', '<p>Open the endpoint to sign in.</p>')
      }
      const endpoints = await this.endpointsOf(login.issuer)
      const state = randomBytes(24).toString('base64url')
      const verifier = randomBytes(32).toString('base64url')
      const nonce = randomBytes(24).toString('base64url')
      const pending: PendingLogin = {
        state,
        bind,
        host,
        path: returnPath(path),
        verifier,
        nonce,
        expires: this.now() + LOGIN_TIMEOUT_MS,
      }
      const authorize = new URL(endpoints.authorize)
      authorize.searchParams.set('response_type', 'code')
      authorize.searchParams.set('client_id', login.clientId)
      authorize.searchParams.set('redirect_uri', this.url(LOGIN_HOST, '/callback'))
      authorize.searchParams.set('scope', login.scope)
      authorize.searchParams.set('state', state)
      authorize.searchParams.set('nonce', nonce)
      authorize.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url'))
      authorize.searchParams.set('code_challenge_method', 'S256')
      res.writeHead(302, {
        location: authorize.toString(),
        'set-cookie': this.loginCookie(pending),
        'cache-control': 'no-store',
      })
      res.end()
      return
    }
    if (url.pathname === '/callback') {
      const state = url.searchParams.get('state') ?? ''
      const pending = this.readLogin(state, req.headers.cookie)
      if (pending) {
        res.setHeader('set-cookie', this.clearLoginCookie(state))
      }
      const code = url.searchParams.get('code')
      if (pending && !code) {
        const error = url.searchParams.get('error') ?? 'no code'
        return page(res, 400, 'Not signed in', `<p>The sign-in did not succeed: ${escape(error.slice(0, 200))}.</p>`)
      }
      if (!pending || !code || !this.spend(pending)) {
        return page(
          res,
          400,
          'Sign-in expired',
          '<p>The sign-in took too long or was used already, open the endpoint again.</p>'
        )
      }
      let principal: Principal
      try {
        principal = await this.exchange(code, pending)
      } catch (e) {
        this.options.log(`endpoint sign-in failed: ${e instanceof Error ? e.message : String(e)}`)
        return page(res, 400, 'Not signed in', '<p>The sign-in could not be checked, open the endpoint again.</p>')
      }
      if (!this.mayEnter(principal, pending.host)) {
        this.options.log(`deny endpoint ${pending.host} iss=${principal.iss} sub=${principal.sub}`)
        return page(
          res,
          403,
          'Not allowed',
          `<p>You signed in as <code>${escape(principal.sub)}</code>, which may not open ${
            pending.host === this.dashboardLabel() ? 'the dashboard of this server' : 'this endpoint'
          }.</p>`
        )
      }
      const issued = randomBytes(24).toString('base64url')
      this.codes.set(issued, {
        bind: pending.bind,
        host: pending.host,
        path: pending.path,
        principal,
        expires: this.now() + CODE_TIMEOUT_MS,
      })
      const target = new URL(this.url(pending.host, `${OWN_PATH}session`))
      target.searchParams.set('code', issued)
      this.options.log(`endpoint sign-in ${pending.host} iss=${principal.iss} sub=${principal.sub}`)
      res.writeHead(302, { location: target.toString(), 'cache-control': 'no-store' })
      res.end()
      return
    }
    return page(res, 404, 'Not found', '<p>There is nothing here.</p>')
  }

  // The code of the issuer for its tokens, and the ID token for who signed in.
  // A sign-in comes back once: its state is kept as spent until it would have expired. Past
  // MAX_SPENT_LOGINS the oldest are forgotten, which anybody can bring about with sign-ins of
  // their own; a state forgotten that way still needs its cookie and a code the issuer takes
  // a second time, which it doesn't (codes of the authorization code flow are one-time).
  private spend(pending: PendingLogin): boolean {
    const now = this.now()
    if (pending.expires < now || this.spent.has(pending.state)) {
      return false
    }
    this.sweep()
    while (this.spent.size >= MAX_SPENT_LOGINS) {
      const oldest = this.spent.keys().next().value as string
      this.spent.delete(oldest)
    }
    this.spent.set(pending.state, pending.expires)
    return true
  }

  private loginCookieName(state: string): string {
    // the state is base64url, which a cookie name may carry
    return `${this.base.scheme === 'https' ? LOGIN_COOKIE : PLAIN_LOGIN_COOKIE}${state.slice(0, 16)}`
  }

  private bindCookieName(bind: string): string {
    return `${this.base.scheme === 'https' ? BIND_COOKIE : PLAIN_BIND_COOKIE}${bind.slice(0, 16)}`
  }

  // A cookie of the host the request is for (no Domain), for so long; 0 clears it.
  private cookie(name: string, value: string, ms: number): string {
    return `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(ms / 1000))}${
      this.base.scheme === 'https' ? '; Secure' : ''
    }`
  }

  private loginCookie(pending: PendingLogin): string {
    const payload = Buffer.from(JSON.stringify(pending)).toString('base64url')
    return this.cookie(
      this.loginCookieName(pending.state),
      `${payload}.${this.sign(`login\0${payload}`)}`,
      LOGIN_TIMEOUT_MS
    )
  }

  private clearLoginCookie(state: string): string {
    return this.cookie(this.loginCookieName(state), '', 0)
  }

  // The sign-in of this state, from its cookie, when the server signed it.
  private readLogin(state: string, header: string | undefined): PendingLogin | null {
    if (!/^[A-Za-z0-9_-]{32}$/.test(state)) {
      return null
    }
    const value = readCookie(header, this.loginCookieName(state))
    const [payload, signature] = (value ?? '').split('.')
    if (!payload || !signature || !safeEqual(signature, this.sign(`login\0${payload}`))) {
      return null
    }
    try {
      const pending = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as PendingLogin
      return pending.state === state && typeof pending.verifier === 'string' && typeof pending.bind === 'string'
        ? pending
        : null
    } catch {
      return null
    }
  }

  private async exchange(code: string, pending: PendingLogin): Promise<Principal> {
    const login = this.config.endpoints?.login
    if (!login || !this.loginVerifier) {
      throw new Error('no sign-in configured')
    }
    const endpoints = await this.endpointsOf(login.issuer)
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: this.url(LOGIN_HOST, '/callback'),
      client_id: login.clientId,
      code_verifier: pending.verifier,
    })
    if (this.options.clientSecret) {
      body.set('client_secret', await this.options.clientSecret())
    }
    const response = await this.fetcher(endpoints.token, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: body.toString(),
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const answer = (await response.json().catch(() => ({}))) as { id_token?: unknown; error?: unknown }
    if (!response.ok || typeof answer.id_token !== 'string') {
      throw new Error(`the token endpoint answered ${response.status}${answer.error ? ` ${String(answer.error)}` : ''}`)
    }
    const principal = await this.loginVerifier.verify(answer.id_token)
    if (principal.claims.nonce !== pending.nonce) {
      throw new TokenError('the ID token is not of this sign-in (nonce)')
    }
    return principal
  }

  private async endpointsOf(issuer: string): Promise<{ authorize: string; token: string }> {
    if (this.discovery && this.now() - this.discovery.at < DISCOVERY_TTL_MS) {
      return this.discovery
    }
    const response = await this.fetcher(`${issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    const metadata = (await response.json()) as Record<string, unknown>
    if (typeof metadata.authorization_endpoint !== 'string' || typeof metadata.token_endpoint !== 'string') {
      throw new Error(`${issuer} names no authorization or token endpoint`)
    }
    this.discovery = { at: this.now(), authorize: metadata.authorization_endpoint, token: metadata.token_endpoint }
    return this.discovery
  }

  // `/.hammerkit/session?code=` on the endpoint host: the one-time code of the sign-in
  // becomes the cookie of this host.
  private takeCode(label: string, req: IncomingMessage, res: ServerResponse, url: URL): void {
    const code = url.searchParams.get('code') ?? ''
    const issued = this.codes.get(code)
    this.codes.delete(code)
    const bind = issued ? readCookie(req.headers.cookie, this.bindCookieName(issued.bind)) : undefined
    if (issued) {
      res.setHeader('set-cookie', this.cookie(this.bindCookieName(issued.bind), '', 0))
    }
    if (
      !issued ||
      issued.host !== label ||
      issued.expires < this.now() ||
      // the browser that started the sign-in at this host, no other one the link was sent to
      !bind ||
      !safeEqual(bind, issued.bind)
    ) {
      return page(
        res,
        400,
        'Sign-in expired',
        '<p>The sign-in took too long or was used already, open the endpoint again.</p>'
      )
    }
    const found = this.registry.endpoint(label)
    const ends = Date.parse(found?.run.expiresAt ?? '')
    const session = this.now() + parseDuration(this.config.endpoints?.session ?? '1h')
    const exp = Number.isFinite(ends) ? Math.min(session, Math.max(ends, this.now() + LOGIN_TIMEOUT_MS)) : session
    res.writeHead(303, {
      location: issued.path,
      'set-cookie': [
        this.cookie(this.bindCookieName(issued.bind), '', 0),
        this.sessionCookie({
          host: label,
          iss: issued.principal.iss,
          sub: issued.principal.sub,
          groups: issued.principal.groups,
          claims: this.matchedClaims(issued.principal),
          exp,
          at: this.now(),
        }),
      ],
      'cache-control': 'no-store',
    })
    res.end()
  }

  // Only the claims an entitlement matches on go into the cookie, which stays small.
  private matchedClaims(principal: Principal): Record<string, string> {
    const names = new Set(
      this.config.entitlements.flatMap((entitlement) => Object.keys(entitlement.claims?.match ?? {}))
    )
    return Object.fromEntries(Object.entries(principal.claims).filter(([name]) => names.has(name)))
  }

  private cookieName(): string {
    return this.base.scheme === 'https' ? SESSION_COOKIE : PLAIN_SESSION_COOKIE
  }

  private sessionCookie(session: Session): string {
    const payload = Buffer.from(JSON.stringify(session)).toString('base64url')
    const value = `${payload}.${this.sign(payload)}`
    const maxAge = Math.max(0, Math.floor((session.exp - this.now()) / 1000))
    return `${this.cookieName()}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${
      this.base.scheme === 'https' ? '; Secure' : ''
    }`
  }

  private clearCookie(): string {
    return `${this.cookieName()}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${
      this.base.scheme === 'https' ? '; Secure' : ''
    }`
  }

  private readSession(label: string, header: string | undefined): Session | null {
    const value = readCookie(header, this.cookieName())
    const [payload, signature] = (value ?? '').split('.')
    if (!payload || !signature || !safeEqual(signature, this.sign(payload))) {
      return null
    }
    try {
      const session = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Session
      if (session.host !== label || !(session.exp > this.now()) || !session.iss || !session.sub) {
        return null
      }
      return {
        ...session,
        groups: Array.isArray(session.groups) ? session.groups : [],
        claims: session.claims ?? {},
      }
    } catch {
      return null
    }
  }

  private sign(value: string): string {
    if (!this.key) {
      throw new Error('the endpoints were not loaded')
    }
    return createHmac('sha256', this.key).update(value).digest('base64url')
  }

  private sweep(): void {
    const now = this.now()
    for (const [state, expires] of this.spent) {
      if (expires < now) {
        this.spent.delete(state)
      }
    }
    for (const [code, issued] of this.codes) {
      if (issued.expires < now) {
        this.codes.delete(code)
      }
    }
  }
}

const BIND_PATTERN = /^[A-Za-z0-9_-]{24}$/

// The page a sign-in goes back to: a path of its own host, and only the path when the query
// is too long for the cookie of the sign-in.
export function returnPath(path: string): string {
  const own = ownPath(path)
  if (own.length <= MAX_RETURN_PATH) {
    return own
  }
  const pathname = own.split('?')[0]
  return pathname.length <= MAX_RETURN_PATH ? pathname : '/'
}

function readCookie(header: string | undefined, name: string): string | undefined {
  return (header ?? '')
    .split(/;\s*/)
    .find((cookie) => cookie.startsWith(`${name}=`))
    ?.slice(name.length + 1)
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a)
  const right = Buffer.from(b)
  return left.length === right.length && timingSafeEqual(left, right)
}

// Whether the browser loads a page of its own, which a sign-in can go through: not a request
// of a page (fetch, htmx, a frame), which would only pile up cookies of sign-ins. Without
// Sec-Fetch-*, an older browser or another client, by its Accept alone.
function isPageLoad(headers: IncomingHttpHeaders): boolean {
  const mode = headers['sec-fetch-mode']
  const dest = headers['sec-fetch-dest']
  return (mode === undefined || mode === 'navigate') && (dest === undefined || dest === 'document')
}

function acceptsHtml(headers: IncomingHttpHeaders): boolean {
  return (headers.accept ?? '').includes('text/html')
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`)
}

async function readText(req: IncomingMessage, limit: number): Promise<string> {
  let text = ''
  for await (const chunk of req) {
    text += chunk.toString('utf8')
    if (text.length > limit) {
      break
    }
  }
  return text.slice(0, limit)
}

// A page of the server's own on an endpoint host: nothing of it is the app's.
function page(res: ServerResponse, status: number, title: string, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-robots-tag': 'noindex',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'",
    'x-frame-options': 'DENY',
  })
  res.end(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escape(
      title
    )}</title><style>body{font:16px/1.5 system-ui,sans-serif;max-width:40rem;margin:3rem auto;padding:0 1rem;color:#222}code{background:#f2f2f2;padding:0 .2em}dt{font-weight:600}dd{margin:0 0 .5rem}</style></head><body><h1>${escape(
      title
    )}</h1>${body}<p><small>hammerkit</small></p></body></html>`
  )
}

// Where on its own host a person goes back to after the sign-in: a path, never an address a
// browser reads as another host (`//x`, `/\\x`, control characters).
export function ownPath(path: string): string {
  if (
    !path.startsWith('/') ||
    [...path].some((char) => char === '\\' || char.charCodeAt(0) < 0x20 || char === '\u007f')
  ) {
    return '/'
  }
  const base = 'http://endpoint.invalid'
  const target = new URL(path, base)
  return target.origin === base ? target.pathname + target.search : '/'
}
