import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from 'http'
import { createServer as createHttpsServer } from 'https'
import { AddressInfo } from 'net'
import { Environment } from '../executer/environment'
import { getVersion } from '../version'
import { detectPlatform, ServerConfig } from './server-config'
import { Principal, TokenError, TokenVerifier, TokenVerifierOptions } from './oauth'
import { getGrant } from './policy'

// Bumped when a client could no longer talk to an older or newer server.
export const SERVER_PROTOCOL = 1
export const DISCOVERY_PATH = '/.well-known/hammerkit'

export interface DiscoveryDocument {
  name: 'hammerkit'
  version: string
  protocol: number
  // OAuth issuers whose tokens the server accepts: public OIDC metadata that
  // `remote add` compares with the issuer given on the command line
  issuers: string[]
  backend: { type: 'host'; platform: { os: string; arch: string } }
}

export function getDiscoveryDocument(config: ServerConfig): DiscoveryDocument {
  return {
    name: 'hammerkit',
    version: getVersion(),
    protocol: SERVER_PROTOCOL,
    issuers: config.issuers.map((i) => i.issuer),
    backend: { type: config.backend.type, platform: config.backend.platform ?? detectPlatform() },
  }
}

export interface RunningServer {
  url: string
  close(): Promise<void>
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers })
  res.end(JSON.stringify(body))
}

export interface ServerOptions extends TokenVerifierOptions {
  // one line per decision about a caller, for the operator
  log?: (line: string) => void
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
  verifier: TokenVerifier,
  log: (line: string) => void,
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
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
    send(res, 200, { iss: principal.iss, sub: principal.sub, accounts: grant.accounts, default: grant.default })
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
  const log = options.log ?? (() => undefined)
  const listener = (req: IncomingMessage, res: ServerResponse) => {
    handle(config, verifier, log, req, res).catch((e) => {
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
        server.closeAllConnections()
      }),
  }
}
