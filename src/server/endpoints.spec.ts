import { createHash } from 'crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, IncomingMessage, request as httpRequest, Server } from 'http'
import { AddressInfo, connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { EndpointGateway, ownPath, returnPath } from './endpoints'
import { TokenVerifier } from './oauth'
import { EndpointTarget, RunExecutor, RunRegistry } from './runs'
import { serverConfigSchema, ServerConfig } from './server-config'
import { getEndpointHosts } from './service-runs'
import { createTestKey, signToken } from '../testing/test-issuer'

const ISS = 'https://idp.corp'
const DOMAIN = 'run.test'
const key = createTestKey('ES256', 'k1')
const alice = { iss: ISS, sub: 'alice' }
// the binding of a sign-in to the browser, for the starts of the tests that go to it directly
const BIND = 'b'.repeat(24)

interface Answer {
  status: number
  body: string
  headers: IncomingMessage['headers']
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)))
}

// The issuer of the sign-in, through the gateway's fetch: discovery, keys, and a token
// endpoint that checks the verifier of PKCE against the challenge it was shown.
function fakeIssuer() {
  const sent: { challenge?: string; nonce?: string; sub: string; token: Record<string, string>[] } = {
    sub: 'alice',
    token: [],
  }
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
    if (url === `${ISS}/.well-known/openid-configuration`) {
      return json({
        issuer: ISS,
        jwks_uri: `${ISS}/jwks`,
        authorization_endpoint: `${ISS}/authorize`,
        token_endpoint: `${ISS}/token`,
      })
    }
    if (url === `${ISS}/jwks`) {
      return json({ keys: [key.jwk] })
    }
    if (url === `${ISS}/token`) {
      const form = Object.fromEntries(new URLSearchParams(String(init?.body)))
      sent.token.push(form)
      const challenge = createHash('sha256').update(form.code_verifier).digest('base64url')
      if (form.code !== 'the-code' || challenge !== sent.challenge) {
        return json({ error: 'invalid_grant' }, 400)
      }
      return json({
        id_token: signToken(key, {
          iss: ISS,
          sub: sent.sub,
          aud: 'endpoints-client',
          nonce: sent.nonce,
          exp: Math.floor(Date.now() / 1000) + 300,
        }),
      })
    }
    return json({ error: 'not found' }, 404)
  }) as typeof fetch
  return { fetcher, sent }
}

// what a service behind an endpoint sees: it echoes the request
async function startApp() {
  const seen: IncomingMessage['headers'][] = []
  const sockets: { destroy(): void }[] = []
  const server = createServer((req, res) => {
    seen.push(req.headers)
    res.setHeader('content-type', 'text/plain')
    res.end(`app ${req.url}`)
  })
  server.on('upgrade', (req, socket) => {
    sockets.push(socket)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nupgrade: echo\r\nconnection: upgrade\r\n\r\n')
    socket.on('data', (data) => socket.write(data))
  })
  const port = await listen(server)
  return { server, port, seen, sockets }
}

describe('EndpointGateway', () => {
  let directory: string
  let app: Awaited<ReturnType<typeof startApp>>
  let gatewayServer: Server
  let port: number
  let config: ServerConfig
  let registry: RunRegistry
  let host: string
  let runId: string
  let issuer: ReturnType<typeof fakeIssuer>
  let gateway: EndpointGateway
  // how far the gateway's clock is ahead
  let ahead: number
  // the built app of the dashboard, and what it asked of the API
  let assets: string
  let api: { calls: { sub: string; method: string; path: string }[] }

  const token = (sub: string) =>
    signToken(key, { iss: ISS, sub, aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 300 })

  const get = (label: string, path: string, headers: Record<string, string> = {}, method = 'GET', body?: string) =>
    new Promise<Answer>((resolve, reject) => {
      const req = httpRequest(
        { host: '127.0.0.1', port, path, method, headers: { ...headers, host: `${label}.${DOMAIN}:${port}` } },
        (res) => {
          let text = ''
          res.on('data', (chunk) => (text += chunk))
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }))
        }
      )
      req.on('error', reject)
      req.end(body)
    })

  // the cookie of the endpoint host that the last sign-in started with
  let bound = ''

  // the browser's way through the sign-in, up to the cookie of the endpoint host
  const signIn = async (path = '/page?x=1', beforeCallback?: () => void, label = host) => {
    const first = await get(label, path, { accept: 'text/html' })
    expect(first.status).toBe(302)
    bound = String(first.headers['set-cookie']).split(';')[0]
    expect(bound).toMatch(/^hammerkit-bind-[A-Za-z0-9_-]{16}=[A-Za-z0-9_-]{24}$/)
    const start = new URL(first.headers.location as string)
    expect(start.host).toBe(`login.${DOMAIN}:${port}`)
    const started = await get('login', start.pathname + start.search)
    // the sign-in under way is a cookie of the login host, for the callback
    const login = String(started.headers['set-cookie']).split(';')[0]
    expect(started.headers['set-cookie']?.[0]).toMatch(/; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/)
    const authorize = new URL(started.headers.location as string)
    expect(authorize.origin + authorize.pathname).toBe(`${ISS}/authorize`)
    expect(authorize.searchParams.get('redirect_uri')).toBe(`http://login.${DOMAIN}:${port}/callback`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    issuer.sent.challenge = authorize.searchParams.get('code_challenge') ?? undefined
    issuer.sent.nonce = authorize.searchParams.get('nonce') ?? undefined
    beforeCallback?.()
    const callback = await get('login', `/callback?code=the-code&state=${authorize.searchParams.get('state')}`, {
      cookie: login,
    })
    if (callback.status === 302) {
      // the cookie of the sign-in goes once it came back
      expect(String(callback.headers['set-cookie'])).toMatch(/^hammerkit-login-[A-Za-z0-9_-]{16}=; .*Max-Age=0/)
    }
    return { callback, state: authorize.searchParams.get('state') as string, login }
  }

  const takeCookie = async (location: string, bind = bound) => {
    const session = new URL(location)
    const taken = await get(session.hostname.slice(0, -DOMAIN.length - 1), session.pathname + session.search, {
      cookie: bind,
    })
    const cookies = ([] as string[]).concat(taken.headers['set-cookie'] ?? [])
    const cookie = cookies.find((line) => line.startsWith('hammerkit-session=')) ?? ''
    return { taken, cookie: cookie.split(';')[0], cookies }
  }

  // a second run of alice's, another endpoint of the same domain (a site)
  const submitOther = async (name: string, sleepTtl?: number) => {
    const [other] = getEndpointHosts(name, alice, [{ service: 'web', port: 80 }])
    const run = registry.submit(alice, {
      definition: 'sha256:' + 'a'.repeat(64),
      tasks: [],
      accounts: [],
      source: { type: 'ref', repo: 'github.com/corp/shop', ref: name, commit: 'c'.repeat(40) },
      options: {},
      up: {
        services: ['web'],
        ttl: 60_000,
        ...(sleepTtl ? { sleepTtl } : {}),
        name,
        endpoints: [{ service: 'web', port: 80, host: other, url: `http://${other}.${DOMAIN}:${port}/` }],
      },
    })
    await until(() => registry.get(alice, run.id)?.state === 'up')
    return { host: other, id: run.id }
  }

  const until = async (condition: () => boolean, tries = 200) => {
    for (let i = 0; i < tries && !condition(); i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    expect(condition()).toBe(true)
  }

  beforeEach(async () => {
    ahead = 0
    directory = mkdtempSync(join(tmpdir(), 'hammerkit-endpoints-'))
    app = await startApp()
    issuer = fakeIssuer()
    config = serverConfigSchema.parse({
      listen: { port: 0 },
      issuers: [{ issuer: ISS, audience: 'hammerkit' }],
      runs: { env: { allow: ['PATH'] } },
      endpoints: { domain: DOMAIN, login: { issuer: ISS, clientId: 'endpoints-client' } },
      entitlements: [
        {
          subject: alice,
          repos: ['github.com/corp/*'],
          builds: 'run',
          endpoints: [{ repo: 'github.com/corp/*', level: 'publish' }],
        },
        { subject: { iss: ISS, sub: 'reviewer' }, endpoints: [{ repo: 'github.com/corp/*', level: 'open' }] },
        { subject: { iss: ISS, sub: 'other' }, endpoints: [{ repo: 'github.com/other/*', level: 'open' }] },
        { subject: { iss: ISS, sub: 'operator' }, observe: true },
        { subject: { iss: ISS, sub: 'colleague' }, repos: ['github.com/corp/*'], builds: 'run' },
        { subject: { iss: ISS, sub: 'stranger' }, repos: ['github.com/other/*'], builds: 'run' },
        { subject: { iss: ISS, sub: 'ci' }, repos: ['github.com/corp/*'], checks: 'read' },
      ],
    })
    const executor: RunExecutor = {
      execute: (_run, context) =>
        new Promise<void>((resolve) => {
          const target: EndpointTarget = { service: 'web', port: 80, address: { host: '127.0.0.1', port: app.port } }
          setTimeout(() => context.up?.([target]), 1)
          context.signal.addEventListener('abort', () => resolve())
        }),
    }
    registry = new RunRegistry({ executor, up: { maxTtl: 3_600_000, perCaller: 5, total: 10 } })
    const verifierOptions = { fetch: issuer.fetcher }
    assets = join(directory, 'dashboard')
    mkdirSync(join(assets, 'assets'), { recursive: true })
    writeFileSync(join(assets, 'index.html'), '<!doctype html><div id="root">the dashboard app</div>')
    writeFileSync(join(assets, 'assets', 'index-abc123.js'), 'console.log(1)')
    api = { calls: [] }
    gateway = new EndpointGateway(config, registry, {
      keyFile: join(directory, 'session.key'),
      verifier: new TokenVerifier(config.issuers, verifierOptions),
      log: () => undefined,
      fetch: issuer.fetcher,
      now: () => Date.now() + ahead,
      // the API answers what it was asked, and by whom
      dashboard: {
        api: async (principal, req, res, url) => {
          api.calls.push({ sub: principal.sub, method: req.method ?? '', path: url.pathname + url.search })
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end('{}')
        },
        assets,
      },
    })
    await gateway.load()
    gatewayServer = createServer((req, res) => {
      const label = gateway.hostOf(req)
      if (!label) {
        res.statusCode = 421
        res.end()
        return
      }
      gateway.handle(label, req, res).catch((e) => {
        res.statusCode = 500
        res.end(String(e))
      })
    })
    gatewayServer.on('upgrade', (req, socket, head) => {
      gateway.upgrade(gateway.hostOf(req) ?? '', req, socket, head)
    })
    port = await listen(gatewayServer)
    gateway.listening(port, false)
    ;[host] = getEndpointHosts('feature', alice, [{ service: 'web', port: 80 }])
    const run = registry.submit(alice, {
      definition: 'sha256:' + 'a'.repeat(64),
      tasks: [],
      accounts: [],
      source: { type: 'ref', repo: 'github.com/corp/shop', ref: 'feature', commit: 'c'.repeat(40) },
      options: {},
      up: {
        services: ['web'],
        ttl: 60_000,
        name: 'feature',
        endpoints: [{ service: 'web', port: 80, host, url: gateway.url(host) }],
      },
    })
    runId = run.id
    for (let i = 0; i < 100 && registry.get(alice, run.id)?.state !== 'up'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
  })

  afterEach(async () => {
    await registry.close()
    app.sockets.forEach((socket) => socket.destroy())
    gatewayServer.closeAllConnections()
    app.server.closeAllConnections()
    await new Promise((resolve) => gatewayServer.close(resolve))
    await new Promise((resolve) => app.server.close(resolve))
    rmSync(directory, { recursive: true, force: true })
  })

  it('signs a person in at the login host and sets a cookie of the endpoint host only', async () => {
    const { callback } = await signIn()
    expect(callback.status).toBe(302)
    // the code of the issuer was exchanged with the verifier of PKCE and the fixed redirect URI
    expect(issuer.sent.token[0]).toMatchObject({
      grant_type: 'authorization_code',
      client_id: 'endpoints-client',
      redirect_uri: `http://login.${DOMAIN}:${port}/callback`,
    })
    const { taken, cookie, cookies } = await takeCookie(callback.headers.location as string)
    expect(taken.status).toBe(303)
    expect(taken.headers.location).toBe('/page?x=1')
    expect(cookies).toHaveLength(2)
    expect(cookies[1]).toMatch(/^hammerkit-session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/)
    // the binding of the sign-in to the browser is spent
    expect(cookies[0]).toMatch(/^hammerkit-bind-[A-Za-z0-9_-]{16}=; Path=\/; HttpOnly; SameSite=Lax; Max-Age=0$/)

    const page = await get(host, '/page?x=1', { cookie: `${cookie}; theme=dark` })
    expect(page).toMatchObject({ status: 200, body: 'app /page?x=1' })
    // the app gets who asked and its own cookies, never the server's
    expect(app.seen[0]).toMatchObject({ 'x-hammerkit-caller': `${ISS} alice`, cookie: 'theme=dark' })
    expect(app.seen[0]['x-forwarded-host']).toBe(`${host}.${DOMAIN}:${port}`)

    // the one-time code is spent, and the cookie is no other host's
    expect((await takeCookie(callback.headers.location as string)).taken.status).toBe(400)
    const [elsewhere] = getEndpointHosts('other', alice, [{ service: 'web', port: 80 }])
    expect((await get(elsewhere, '/', { cookie })).status).toBe(404)
  })

  describe('dashboard', () => {
    const as = (sub: string) => ({ 'hammerkit-authorization': `Bearer ${token(sub)}` })
    const own = () => ({ 'sec-fetch-site': 'same-origin', origin: `http://hammerkit.${DOMAIN}:${port}` })
    const sessionOf = async (headers: Record<string, string>) =>
      JSON.parse((await get('hammerkit', '/api/session', headers)).body) as {
        sub: string
        csrf: string
        decideUntil?: string
      }
    const send = (path: string, headers: Record<string, string>, csrf?: string) =>
      get(
        'hammerkit',
        path,
        { ...headers, 'content-type': 'application/json', ...(csrf ? { 'x-hammerkit-csrf': csrf } : {}) },
        'POST',
        '{}'
      )

    it('signs a person in at its own host, and serves the app', async () => {
      const { callback } = await signIn('/services', undefined, 'hammerkit')
      expect(callback.status).toBe(302)
      const { taken, cookie } = await takeCookie(callback.headers.location as string)
      expect(taken.headers.location).toBe('/services')
      // every page of the app is its index.html, which draws it
      const page = await get('hammerkit', '/services', { cookie })
      expect(page.status).toBe(200)
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(page.body).toContain('the dashboard app')
      // its own script and style only, that nobody frames
      const policy = page.headers['content-security-policy'] as string
      expect(policy).toContain("default-src 'none'")
      expect(policy).toContain("script-src 'self'")
      expect(policy).toContain("connect-src 'self'")
      expect(policy).toContain("frame-ancestors 'none'")
      expect(policy).not.toContain('unsafe-inline')
      const script = await get('hammerkit', '/assets/index-abc123.js', { cookie })
      expect(script.status).toBe(200)
      expect(script.headers['content-type']).toBe('text/javascript; charset=utf-8')
      expect(script.headers['cache-control']).toContain('immutable')
      expect((await get('hammerkit', '/assets/%2e%2e%2fsession.key', { cookie })).status).toBe(404)
      expect((await get('hammerkit', '/assets/nope.js', { cookie })).status).toBe(404)
      // who signed in, and the token of what the app sends
      const session = await sessionOf({ cookie })
      expect(session.sub).toBe('alice')
      expect(session.csrf).toMatch(/.{20,}/)
      expect(Date.parse(session.decideUntil ?? '')).toBeGreaterThan(Date.now())
      // the cookie of the dashboard opens no endpoint, and the other way round
      expect((await get(host, '/', { cookie })).status).toBe(401)
      expect((await get('hammerkit', '/', { cookie: `hammerkit-session=forged.forged` })).status).toBe(401)
    })

    it('does not sign in somebody with no entitlement, and checks the entitlements of the moment', async () => {
      issuer.sent.sub = 'nobody'
      const { callback } = await signIn('/', undefined, 'hammerkit')
      expect(callback.status).toBe(403)
      expect(callback.body).toContain('the dashboard of this server')
      expect((await get('hammerkit', '/api/session', as('reviewer'))).status).toBe(200)
      config.entitlements = config.entitlements.filter((entitlement) => entitlement.subject?.sub !== 'reviewer')
      expect((await get('hammerkit', '/api/session', as('reviewer'))).status).toBe(403)
      expect((await get('hammerkit', '/api/v1/overview', as('reviewer'))).status).toBe(403)
      expect(api.calls).toEqual([])
    })

    it('passes what the pages read on to the API as who signed in, and nothing else', async () => {
      const read = await get('hammerkit', `/api/v1/runs?scope=visible&id=${runId}`, as('colleague'))
      expect(read.status).toBe(200)
      expect(await get('hammerkit', `/api/v1/runs/${runId}/logs?tail=200`, as('alice'))).toMatchObject({ status: 200 })
      expect(api.calls).toEqual([
        { sub: 'colleague', method: 'GET', path: `/v1/runs?scope=visible&id=${runId}` },
        { sub: 'alice', method: 'GET', path: `/v1/runs/${runId}/logs?tail=200` },
      ])
      // what the pages do not read: the events of a run, the files of a sandbox, secrets
      for (const path of [`/api/v1/runs/${runId}/events`, '/api/v1/sandboxes/sbx_aaaaaaaaaaaaaaaa/tree', '/api/nope']) {
        expect((await get('hammerkit', path, as('alice'))).status).toBe(404)
      }
      // what they do not do: start a run, publish a build file, or delete anything
      const csrf = (await sessionOf(as('alice'))).csrf
      expect((await send('/api/v1/runs', as('alice'), csrf)).status).toBe(405)
      expect((await send('/api/v1/definitions', as('alice'), csrf)).status).toBe(405)
      expect((await get('hammerkit', '/api/v1/overview', as('alice'), 'DELETE')).status).toBe(405)
      expect((await get('hammerkit', '/services', as('alice'), 'POST', '')).status).toBe(405)
      expect(api.calls).toHaveLength(2)
    })

    it('does what the buttons do with the token of the sign-in, from its own page only', async () => {
      issuer.sent.sub = 'alice'
      const { callback } = await signIn('/', undefined, 'hammerkit')
      const { cookie } = await takeCookie(callback.headers.location as string)
      const { csrf } = await sessionOf({ cookie })
      const extend = `/api/v1/runs/${runId}/extend`
      expect((await send(extend, { cookie, ...own() }, csrf)).status).toBe(200)
      expect(api.calls).toEqual([{ sub: 'alice', method: 'POST', path: `/v1/runs/${runId}/extend` }])
      // without the token, or with the token of an API caller
      expect((await send(extend, { cookie, ...own() })).status).toBe(403)
      expect((await send(extend, { cookie, ...own() }, 'forged')).status).toBe(403)
      const tokens = await sessionOf(as('alice'))
      expect(tokens.csrf).not.toBe(csrf)
      expect(tokens.decideUntil).toBeUndefined()
      expect((await send(extend, { cookie, ...own() }, tokens.csrf)).status).toBe(403)
      // an endpoint of somebody's service run is the same site, and the browser sends the cookie
      const sameSite = { cookie, 'sec-fetch-site': 'same-site', origin: `http://${host}.${DOMAIN}:${port}` }
      expect((await send(extend, sameSite, csrf)).status).toBe(401)
      // an old browser without Sec-Fetch, by its Origin
      expect((await send(extend, { cookie, origin: 'http://evil.example' }, csrf)).status).toBe(401)
      // in a frame of another page
      expect(
        (await get('hammerkit', '/', { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-dest': 'iframe' })).status
      ).toBe(401)
      expect(api.calls).toHaveLength(1)
    })

    it('lets a sign-in decide for its first minutes, then signs the person in again', async () => {
      issuer.sent.sub = 'alice'
      const { callback } = await signIn('/', undefined, 'hammerkit')
      const { cookie } = await takeCookie(callback.headers.location as string)
      const { csrf } = await sessionOf({ cookie })
      const decide = () => send('/api/v1/approvals/run_0000000000000000/approve', { cookie, ...own() }, csrf)
      const publish = () => send(`/api/v1/proposals/sha256:${'b'.repeat(64)}/reject`, { cookie, ...own() }, csrf)
      expect((await decide()).status).toBe(200)
      expect((await publish()).status).toBe(200)
      ahead = 16 * 60_000
      for (const late of [await decide(), await publish()]) {
        expect(late.status).toBe(403)
        expect(JSON.parse(late.body)).toMatchObject({ signInAgain: true })
      }
      // stop and extend do not need it
      expect((await send(`/api/v1/runs/${runId}/cancel`, { cookie, ...own() }, csrf)).status).toBe(200)
      expect(api.calls.map((call) => call.path)).toEqual([
        '/v1/approvals/run_0000000000000000/approve',
        `/v1/proposals/sha256:${'b'.repeat(64)}/reject`,
        `/v1/runs/${runId}/cancel`,
      ])
      // an API token is new
      const tokens = await sessionOf(as('alice'))
      expect((await send('/api/v1/approvals/run_0000000000000000/reject', as('alice'), tokens.csrf)).status).toBe(200)
      // signing in again goes through the login host, back to a page of the dashboard only
      for (const [path, back] of [
        ['%2Fapprovals', '/approvals'],
        ['%2F%2Fevil.example', '/'],
        ['https%3A%2F%2Fevil.example', '/'],
      ]) {
        const again = await get('hammerkit', `/.hammerkit/signin?path=${path}`, { cookie, accept: 'text/html' })
        expect(again.status).toBe(302)
        const start = new URL(again.headers.location as string)
        expect(start.host).toBe(`login.${DOMAIN}:${port}`)
        expect(start.searchParams.get('path')).toBe(back)
      }
    })

    it('asks to sign in again when the sign-in ended, and says when the app was not built', async () => {
      // what the app asks without a sign-in: 401, which sends the page to sign in again
      expect((await get('hammerkit', '/api/session', { accept: 'application/json' })).status).toBe(401)
      expect((await get('hammerkit', '/runs', { accept: 'text/html' })).status).toBe(302)
      rmSync(join(assets, 'index.html'))
      const missing = await get('hammerkit', '/', as('alice'))
      expect(missing.status).toBe(503)
      expect(missing.body).toContain('npm run build:dashboard')
    })

    it('is not there when switched off', async () => {
      config.endpoints = { ...config.endpoints!, dashboard: false }
      expect((await get('hammerkit', '/', as('alice'))).status).toBe(404)
    })
  })

  it('refuses a sign-in whose state or code is not the one it started', async () => {
    const { state, login } = await signIn()
    // the state is used once, even with its cookie sent again
    expect((await get('login', `/callback?code=the-code&state=${state}`, { cookie: login })).status).toBe(400)
    expect((await get('login', `/callback?code=the-code&state=${state}`)).status).toBe(400)
    expect((await get('login', '/callback?code=the-code&state=forged', { cookie: login })).status).toBe(400)
    // the cookie of one sign-in is not another's, nor one the server did not sign
    const fresh = await get('login', `/start?host=${host}&path=/&bind=${BIND}`)
    const authorize = new URL(fresh.headers.location as string)
    const freshState = authorize.searchParams.get('state') as string
    issuer.sent.challenge = authorize.searchParams.get('code_challenge') ?? undefined
    issuer.sent.nonce = authorize.searchParams.get('nonce') ?? undefined
    const [freshName, freshValue] = String(fresh.headers['set-cookie']).split(';')[0].split('=')
    const [freshPayload, freshSignature] = freshValue.split('.')
    const callback = (cookie: string) => get('login', `/callback?code=the-code&state=${freshState}`, { cookie })
    const another = await get('login', `/start?host=${host}&path=/&bind=${BIND}`)
    const anotherValue = String(another.headers['set-cookie']).split(';')[0].split('=')[1]
    // even when the issuer would take the code with the verifier of that other sign-in
    const anotherAuthorize = new URL(another.headers.location as string)
    issuer.sent.challenge = anotherAuthorize.searchParams.get('code_challenge') ?? undefined
    issuer.sent.nonce = anotherAuthorize.searchParams.get('nonce') ?? undefined
    expect((await callback(`${freshName}=${anotherValue}`)).status).toBe(400)
    issuer.sent.challenge = authorize.searchParams.get('code_challenge') ?? undefined
    issuer.sent.nonce = authorize.searchParams.get('nonce') ?? undefined
    const changed = Buffer.from(
      JSON.stringify({ ...JSON.parse(Buffer.from(freshPayload, 'base64url').toString()), path: '/elsewhere' })
    ).toString('base64url')
    expect((await callback(`${freshName}=${changed}.${freshSignature}`)).status).toBe(400)
    // and the untouched one still goes through
    expect((await callback(`${freshName}=${freshValue}`)).status).toBe(302)
  })

  it('takes the code of a sign-in only in the browser that started it', async () => {
    const first = await signIn()
    const started = bound
    // sent to somebody else, the link of the code signs them in as nobody
    const elsewhere = await takeCookie(first.callback.headers.location as string, '')
    expect(elsewhere.taken.status).toBe(400)
    expect(elsewhere.cookie).toBe('')
    const second = await signIn()
    const [name] = bound.split('=')
    expect(
      (await takeCookie(second.callback.headers.location as string, `${name}=${'c'.repeat(24)}`)).taken.status
    ).toBe(400)
    const third = await signIn()
    expect((await takeCookie(third.callback.headers.location as string, started)).taken.status).toBe(400)
    // and a start the endpoint did not send the browser to has no binding
    expect((await get('login', `/start?host=${host}&path=/`)).status).toBe(400)
  })

  it('keeps a long page to go back to out of the cookie of the sign-in, which a browser would drop', async () => {
    const path = `/search?q=${'x'.repeat(4000)}`
    const first = await get(host, path, { accept: 'text/html' })
    const started = await get(
      'login',
      new URL(first.headers.location as string).pathname + new URL(first.headers.location as string).search
    )
    const login = String(started.headers['set-cookie']).split(';')[0]
    expect(login.length).toBeLessThanOrEqual(4096)
    expect(returnPath(path)).toBe('/search')
    expect(returnPath(`/${'p'.repeat(2000)}`)).toBe('/')
    expect(returnPath('/page?x=1')).toBe('/page?x=1')
    const { callback } = await signIn(path)
    const { taken } = await takeCookie(callback.headers.location as string)
    expect(taken.headers.location).toBe('/search')
  })

  it('names and secures its cookies for https', async () => {
    gateway.listening(port, true)
    const first = await get(host, '/page', { accept: 'text/html' })
    const bind = String(first.headers['set-cookie'])
    expect(bind).toMatch(
      /^__Host-hammerkit-bind-[A-Za-z0-9_-]{16}=[A-Za-z0-9_-]{24}; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/
    )
    const start = new URL(first.headers.location as string)
    expect(start.protocol).toBe('https:')
    const started = await get('login', start.pathname + start.search)
    const login = String(started.headers['set-cookie'])
    expect(login).toMatch(
      /^__Host-hammerkit-login-[A-Za-z0-9_-]{16}=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/
    )
    const authorize = new URL(started.headers.location as string)
    issuer.sent.challenge = authorize.searchParams.get('code_challenge') ?? undefined
    issuer.sent.nonce = authorize.searchParams.get('nonce') ?? undefined
    const callback = await get('login', `/callback?code=the-code&state=${authorize.searchParams.get('state')}`, {
      cookie: login.split(';')[0],
    })
    expect(callback.status).toBe(302)
    expect(String(callback.headers['set-cookie'])).toMatch(
      /^__Host-hammerkit-login-[A-Za-z0-9_-]{16}=; .*Max-Age=0; Secure$/
    )
    const { taken, cookies } = await takeCookie(callback.headers.location as string, bind.split(';')[0])
    expect(taken.status).toBe(303)
    expect(cookies[0]).toMatch(/^__Host-hammerkit-bind-[A-Za-z0-9_-]{16}=; .*Max-Age=0; Secure$/)
    expect(cookies[1]).toMatch(/^__Host-hammerkit-session=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=\d+; Secure$/)
    const session = cookies[1].split(';')[0]
    expect((await get(host, '/page', { cookie: session })).status).toBe(200)
  })

  it('sends only a page load to the sign-in, and gives no other request a cookie', async () => {
    for (const headers of [
      { 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-mode': 'no-cors', 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'iframe' },
    ]) {
      const answer = await get(host, '/poll', { accept: 'text/html, */*', ...headers })
      expect(answer.status).toBe(401)
      expect(answer.headers['set-cookie']).toBeUndefined()
    }
    const loaded = await get(host, '/page', {
      accept: 'text/html',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-dest': 'document',
    })
    expect(loaded.status).toBe(302)
    expect(String(loaded.headers['set-cookie'])).toMatch(/^hammerkit-bind-/)
  })

  it('keeps no table of sign-ins under way that callers who are not signed in could fill', async () => {
    for (let i = 0; i < 1100; i++) {
      expect((await get('login', `/start?host=${host}&path=/&bind=${BIND}`)).status).toBe(302)
    }
    const { callback } = await signIn()
    expect(callback.status).toBe(302)
  })

  it('starts a sign-in when a person goes to it only, not for a request of a page', async () => {
    const fetched = await get('login', `/start?host=${host}&path=/&bind=${BIND}`, { 'sec-fetch-mode': 'no-cors' })
    expect(fetched.status).toBe(403)
    expect(fetched.headers['set-cookie']).toBeUndefined()
    const navigated = await get('login', `/start?host=${host}&path=/&bind=${BIND}`, { 'sec-fetch-mode': 'navigate' })
    expect(navigated.status).toBe(302)
  })

  it('checks the entitlements of the moment for a cookie it gave', async () => {
    issuer.sent.sub = 'reviewer'
    const { callback } = await signIn()
    const { cookie } = await takeCookie(callback.headers.location as string)
    expect((await get(host, '/', { cookie })).status).toBe(200)
    config.entitlements = config.entitlements.filter((entitlement) => entitlement.subject?.sub !== 'reviewer')
    const refused = await get(host, '/', { cookie })
    expect(refused.status).toBe(403)
    expect(refused.body).not.toContain('app')
  })

  it('does not sign in somebody who may not open the endpoint', async () => {
    issuer.sent.sub = 'other'
    const { callback } = await signIn()
    expect(callback.status).toBe(403)
  })

  it('takes a token in Hammerkit-Authorization, and says 401 without one', async () => {
    expect((await get(host, '/')).status).toBe(401)
    expect((await get(host, '/', { 'hammerkit-authorization': `Bearer ${token('reviewer')}` })).status).toBe(200)
    expect((await get(host, '/', { 'hammerkit-authorization': `Bearer ${token('other')}` })).status).toBe(403)
    expect((await get(host, '/', { 'hammerkit-authorization': 'Bearer not-a-token' })).status).toBe(401)
    expect(app.seen.every((headers) => headers['hammerkit-authorization'] === undefined)).toBe(true)
  })

  it('extends the run from its status page, with the token of the form', async () => {
    const auth = { 'hammerkit-authorization': `Bearer ${token('reviewer')}` }
    const status = await get(host, '/.hammerkit/status', auth)
    expect(status.status).toBe(200)
    expect(status.body).toContain(runId)
    const csrf = /name="csrf" value="([^"]+)"/.exec(status.body)?.[1] as string
    const before = registry.get(alice, runId)?.expiresAt
    const form = { ...auth, 'content-type': 'application/x-www-form-urlencoded' }
    expect((await get(host, '/.hammerkit/extend', form, 'POST', 'csrf=forged&ttl=8h')).status).toBe(403)
    expect((await get(host, '/.hammerkit/extend', form, 'POST', `csrf=${csrf}&ttl=8h`)).status).toBe(303)
    expect(Date.parse(registry.get(alice, runId)?.expiresAt ?? '')).toBeGreaterThan(Date.parse(before ?? ''))
  })

  it('says the endpoint ended once its run stopped', async () => {
    registry.cancel(alice, runId)
    for (let i = 0; i < 100 && registry.get(alice, runId)?.state === 'up'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const ended = await get(host, '/', { 'hammerkit-authorization': `Bearer ${token('alice')}` })
    expect(ended.status).toBe(410)
    expect(ended.body).toContain('alice stopped it')
  })

  it('passes an upgrade through to the app after the same checks', async () => {
    const upgrade = (headers: string) =>
      new Promise<string>((resolve) => {
        const socket = connect(port, '127.0.0.1', () => {
          socket.write(
            `GET /ws HTTP/1.1\r\nhost: ${host}.${DOMAIN}\r\nconnection: upgrade\r\nupgrade: echo\r\n${headers}\r\n`
          )
        })
        let text = ''
        socket.on('data', (data) => {
          text += data.toString()
          if (text.includes('101') && !text.includes('ping')) {
            socket.write('ping')
          }
          if (text.includes('ping') || !text.includes('101')) {
            socket.end()
            resolve(text)
          }
        })
      })
    expect(await upgrade('')).toMatch(/^HTTP\/1.1 401/)
    const echoed = await upgrade(`hammerkit-authorization: Bearer ${token('alice')}\r\n`)
    expect(echoed).toMatch(/^HTTP\/1.1 101/)
    expect(echoed).toContain('ping')
    // a browser's WebSocket carries the cookie of the sign-in
    issuer.sent.sub = 'reviewer'
    const { callback } = await signIn()
    const { cookie } = await takeCookie(callback.headers.location as string)
    expect(await upgrade(`cookie: ${cookie}\r\norigin: http://${host}.${DOMAIN}:${port}\r\n`)).toMatch(/^HTTP\/1.1 101/)
    // not one the page of another endpoint opens, nor one without an origin
    const sibling = `origin: http://evil-80-123456.${DOMAIN}:${port}\r\n`
    expect(await upgrade(`cookie: ${cookie}\r\n${sibling}`)).toMatch(/^HTTP\/1.1 401/)
    expect(await upgrade(`cookie: ${cookie}\r\n`)).toMatch(/^HTTP\/1.1 401/)
    // nor by somebody who may not open it
    expect(await upgrade(`hammerkit-authorization: Bearer ${token('other')}\r\n`)).toMatch(/^HTTP\/1.1 403/)
    // the server's own paths are not the app's
    const own = await new Promise<string>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write(
          `GET /.hammerkit/status HTTP/1.1\r\nhost: ${host}.${DOMAIN}\r\nconnection: upgrade\r\nupgrade: echo\r\n` +
            `hammerkit-authorization: Bearer ${token('alice')}\r\n\r\n`
        )
      })
      socket.on('data', (data) => {
        socket.end()
        resolve(data.toString())
      })
    })
    expect(own).toMatch(/^HTTP\/1.1 404/)
  })

  it('refuses a cookie that is forged, or of another endpoint host', async () => {
    issuer.sent.sub = 'reviewer'
    const { callback } = await signIn()
    const { cookie } = await takeCookie(callback.headers.location as string)
    expect((await get(host, '/', { cookie })).status).toBe(200)
    // a payload of somebody else with the signature of this one
    const [name, value] = cookie.split('=')
    const [payload, signature] = value.split('.')
    const session = JSON.parse(Buffer.from(payload, 'base64url').toString())
    const forged = Buffer.from(JSON.stringify({ ...session, sub: 'alice' })).toString('base64url')
    expect((await get(host, '/', { cookie: `${name}=${forged}.${signature}` })).status).toBe(401)
    expect((await get(host, '/', { cookie: `${name}=${payload}.${'A'.repeat(signature.length)}` })).status).toBe(401)
    // a real endpoint the same person may open is another host: the cookie is not its
    const other = await submitOther('second')
    expect((await get(other.host, '/', { cookie })).status).toBe(401)
    expect(app.seen.filter((headers) => headers['x-hammerkit-caller'] === `${ISS} reviewer`)).toHaveLength(1)
  })

  it('takes the one-time code of the sign-in at its own host only, and for a minute', async () => {
    issuer.sent.sub = 'reviewer'
    const other = await submitOther('second')
    const first = await signIn()
    const elsewhere = new URL(first.callback.headers.location as string)
    elsewhere.hostname = `${other.host}.${DOMAIN}`
    expect((await takeCookie(elsewhere.toString())).taken.status).toBe(400)
    const late = await signIn()
    ahead = 61_000
    expect((await takeCookie(late.callback.headers.location as string)).taken.status).toBe(400)
  })

  it('refuses an ID token of another sign-in (nonce)', async () => {
    const { callback } = await signIn('/', () => {
      issuer.sent.nonce = 'another'
    })
    expect(callback.status).toBe(400)
  })

  it('goes back to a path of the endpoint after the sign-in, never to another host', async () => {
    for (const path of ['/\\evil.example', '//evil.example', '/%5Cevil']) {
      const { callback } = await signIn(path)
      const { taken } = await takeCookie(callback.headers.location as string)
      expect(new URL(taken.headers.location as string, 'http://x').host).toBe('x')
    }
    expect(ownPath('/\\evil.example')).toBe('/')
    expect(ownPath('//evil.example')).toBe('/')
    expect(ownPath('https://evil.example/')).toBe('/')
    expect(ownPath('/a\tb')).toBe('/')
    expect(ownPath('/page?x=1')).toBe('/page?x=1')
  })

  it('does not act as the person for a page of another endpoint', async () => {
    issuer.sent.sub = 'reviewer'
    const { callback } = await signIn()
    const { cookie } = await takeCookie(callback.headers.location as string)
    const sibling = `http://evil-80-123456.${DOMAIN}:${port}`
    const seen = app.seen.length
    // a form or fetch of a sibling page
    const post = { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors', origin: sibling }
    expect((await get(host, '/api/delete', post, 'POST')).status).toBe(401)
    const form = { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate', origin: sibling }
    expect((await get(host, '/api/delete', form, 'POST')).status).toBe(401)
    // a browser without Sec-Fetch-*, by its Origin
    expect((await get(host, '/api/delete', { cookie, origin: sibling }, 'POST')).status).toBe(401)
    expect(app.seen.length).toBe(seen)
    // a link followed from a sibling page, and the endpoint's own requests
    const link = { cookie, 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'navigate' }
    expect((await get(host, '/', link)).status).toBe(200)
    expect((await get(host, '/', { ...link, 'sec-fetch-dest': 'document' })).status).toBe(200)
    // not the endpoint in a frame of a sibling page
    expect((await get(host, '/', { ...link, 'sec-fetch-dest': 'iframe' })).status).toBe(401)
    const own = { cookie, 'sec-fetch-site': 'same-origin', origin: `http://${host}.${DOMAIN}:${port}` }
    expect((await get(host, '/api/save', own, 'POST')).status).toBe(200)
  })

  it('keeps its own paths from the app', async () => {
    const auth = { 'hammerkit-authorization': `Bearer ${token('alice')}` }
    const seen = app.seen.length
    expect((await get(host, '/.hammerkit/anything', auth)).status).toBe(404)
    expect(app.seen.length).toBe(seen)
  })

  it('wakes a run that sleeps on a request, and keeps one that is up awake', async () => {
    // long enough for a request on a slow runner to keep it up
    const sleepy = await submitOther('sleepy', 1000)
    const auth = { 'hammerkit-authorization': `Bearer ${token('reviewer')}` }
    // requests keep it up past its sleepTtl
    for (let i = 0; i < 4; i++) {
      expect((await get(sleepy.host, '/', auth)).status).toBe(200)
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    expect(registry.get(alice, sleepy.id)?.state).toBe('up')
    await until(() => registry.get(alice, sleepy.id)?.state === 'asleep', 1000)
    // somebody who may not open it does not wake it
    expect((await get(sleepy.host, '/', { 'hammerkit-authorization': `Bearer ${token('other')}` })).status).toBe(403)
    expect(registry.get(alice, sleepy.id)?.state).toBe('asleep')
    const waking = await get(sleepy.host, '/', { ...auth, accept: 'text/html' })
    expect(waking.status).toBe(503)
    expect(waking.body).toContain('waking up')
    expect(waking.headers.refresh).toBe('5')
    await until(() => registry.get(alice, sleepy.id)?.state === 'up')
    expect(registry.get(alice, sleepy.id)?.wakes).toBe(1)
    expect((await get(sleepy.host, '/', auth)).status).toBe(200)
  })

  it('keeps a run asleep while its owner has no place for it, and says so', async () => {
    const sleepy = await submitOther('sleepy', 50)
    await until(() => registry.get(alice, sleepy.id)?.state === 'asleep')
    // with feature, alice has all 5 places
    for (const name of ['one', 'two', 'three', 'four']) {
      await submitOther(name)
    }
    const auth = { 'hammerkit-authorization': `Bearer ${token('reviewer')}`, accept: 'text/html' }
    const asleep = await get(sleepy.host, '/', auth)
    expect(asleep.status).toBe(503)
    expect(asleep.headers.refresh).toBe('30')
    expect(asleep.headers['retry-after']).toBe('30')
    expect(asleep.body).toContain('it wakes once one of them stops or sleeps')
    expect(registry.get(alice, sleepy.id)?.state).toBe('asleep')
  })
})
