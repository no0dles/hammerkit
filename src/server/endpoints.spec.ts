import { createHash } from 'crypto'
import { mkdtempSync, rmSync } from 'fs'
import { createServer, IncomingMessage, request as httpRequest, Server } from 'http'
import { AddressInfo, connect } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { EndpointGateway } from './endpoints'
import { TokenVerifier } from './oauth'
import { EndpointTarget, RunExecutor, RunRegistry } from './runs'
import { serverConfigSchema, ServerConfig } from './server-config'
import { getEndpointHosts } from './service-runs'
import { createTestKey, signToken } from '../testing/test-issuer'

const ISS = 'https://idp.corp'
const DOMAIN = 'run.test'
const key = createTestKey('ES256', 'k1')
const alice = { iss: ISS, sub: 'alice' }

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

  // the browser's way through the sign-in, up to the cookie of the endpoint host
  const signIn = async (path = '/page?x=1') => {
    const first = await get(host, path, { accept: 'text/html' })
    expect(first.status).toBe(302)
    const start = new URL(first.headers.location as string)
    expect(start.host).toBe(`login.${DOMAIN}:${port}`)
    const authorize = new URL((await get('login', start.pathname + start.search)).headers.location as string)
    expect(authorize.origin + authorize.pathname).toBe(`${ISS}/authorize`)
    expect(authorize.searchParams.get('redirect_uri')).toBe(`http://login.${DOMAIN}:${port}/callback`)
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256')
    issuer.sent.challenge = authorize.searchParams.get('code_challenge') ?? undefined
    issuer.sent.nonce = authorize.searchParams.get('nonce') ?? undefined
    const callback = await get('login', `/callback?code=the-code&state=${authorize.searchParams.get('state')}`)
    return { callback, state: authorize.searchParams.get('state') as string }
  }

  const takeCookie = async (location: string) => {
    const session = new URL(location)
    const taken = await get(session.hostname.slice(0, -DOMAIN.length - 1), session.pathname + session.search)
    return { taken, cookie: String(taken.headers['set-cookie']).split(';')[0] }
  }

  beforeEach(async () => {
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
    registry = new RunRegistry({ executor })
    const verifierOptions = { fetch: issuer.fetcher }
    const gateway = new EndpointGateway(config, registry, {
      keyFile: join(directory, 'session.key'),
      verifier: new TokenVerifier(config.issuers, verifierOptions),
      log: () => undefined,
      fetch: issuer.fetcher,
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
    const { taken, cookie } = await takeCookie(callback.headers.location as string)
    expect(taken.status).toBe(303)
    expect(taken.headers.location).toBe('/page?x=1')
    expect(String(taken.headers['set-cookie'])).toMatch(/^hammerkit-session=[^;]+; Path=\/; HttpOnly; SameSite=Lax/)

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

  it('refuses a sign-in whose state or code is not the one it started', async () => {
    const { state } = await signIn()
    // the state is used once
    expect((await get('login', `/callback?code=the-code&state=${state}`)).status).toBe(400)
    expect((await get('login', '/callback?code=the-code&state=forged')).status).toBe(400)
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
    expect(await upgrade(`cookie: ${cookie}\r\norigin: http://${host}.${DOMAIN}\r\n`)).toMatch(/^HTTP\/1.1 101/)
  })
})
