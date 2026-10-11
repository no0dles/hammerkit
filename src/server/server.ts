import { createServer as createHttpServer, IncomingMessage, Server, ServerResponse } from 'http'
import { createServer as createHttpsServer } from 'https'
import { AddressInfo } from 'net'
import { Environment } from '../executer/environment'
import { getVersion } from '../version'
import { detectPlatform, ServerConfig } from './server-config'

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

function handle(config: ServerConfig, req: IncomingMessage, res: ServerResponse): void {
  const path = new URL(req.url ?? '/', 'http://localhost').pathname
  if (path === DISCOVERY_PATH || path === '/healthz') {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      send(res, 405, { error: 'method not allowed' }, { allow: 'GET, HEAD' })
      return
    }
    send(res, 200, path === '/healthz' ? { status: 'ok' } : getDiscoveryDocument(config))
    return
  }
  // everything else needs a token, which arrives with the OAuth support
  send(res, 404, { error: 'not found' })
}

export async function startServer(config: ServerConfig, environment: Environment): Promise<RunningServer> {
  const listener = (req: IncomingMessage, res: ServerResponse) => handle(config, req, res)
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
