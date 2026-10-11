import { createServer, Server } from 'http'
import { AddressInfo } from 'net'
import { constants, createSign, generateKeyPairSync, KeyObject, sign } from 'crypto'

export interface TestKey {
  kid: string
  alg: string
  privateKey: KeyObject
  jwk: Record<string, unknown>
}

export function createTestKey(alg: 'RS256' | 'PS256' | 'ES256', kid: string): TestKey {
  const pair =
    alg === 'ES256'
      ? generateKeyPairSync('ec', { namedCurve: 'P-256' })
      : generateKeyPairSync('rsa', { modulusLength: 2048 })
  return {
    kid,
    alg,
    privateKey: pair.privateKey,
    jwk: { ...pair.publicKey.export({ format: 'jwk' }), kid, alg, use: 'sig' },
  }
}

const base64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')

// signs a JWT the way an identity provider does
export function signToken(
  key: TestKey,
  payload: Record<string, unknown>,
  header: Record<string, unknown> = {}
): string {
  const head = base64url({ alg: key.alg, kid: key.kid, typ: 'JWT', ...header })
  const data = Buffer.from(`${head}.${base64url(payload)}`)
  let signature: Buffer
  if (key.alg === 'ES256') {
    signature = sign('sha256', data, { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
  } else if (key.alg === 'PS256') {
    signature = sign('sha256', data, {
      key: key.privateKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: constants.RSA_PSS_SALTLEN_DIGEST,
    })
  } else {
    signature = createSign('sha256').update(data).sign(key.privateKey)
  }
  return `${data.toString()}.${signature.toString('base64url')}`
}

// A device authorization grant (RFC 8628) the test issuer can play through.
export interface TestDeviceFlow {
  clientId: string
  // the access token to hand out once the user has "approved"
  token: () => string
  // seconds the user is told to wait between polls (default 1)
  interval?: number
  // answers authorization_pending this many times before approving
  pending?: number
  // instead of approving, answer with this error
  error?: string
  // form bodies received, in order
  requests?: Record<string, string>[]
}

export interface TestIssuer {
  url: string
  keys: TestKey[]
  device?: TestDeviceFlow
  // replaces fields of the discovery document, undefined removes one
  metadata?: Record<string, unknown>
  // how often the keys were fetched
  fetches: { metadata: number; jwks: number }
  close(): Promise<void>
}

// An OpenID provider on the loopback interface: discovery document and keys.
export async function startTestIssuer(keys: TestKey[], device?: TestDeviceFlow): Promise<TestIssuer> {
  const issuer: TestIssuer = { url: '', keys, device, fetches: { metadata: 0, jwks: 0 }, close: async () => undefined }
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      issuer.fetches.metadata++
      res.end(
        JSON.stringify({
          issuer: issuer.url,
          jwks_uri: `${issuer.url}/jwks`,
          device_authorization_endpoint: `${issuer.url}/device`,
          token_endpoint: `${issuer.url}/token`,
          ...issuer.metadata,
        })
      )
    } else if ((req.url === '/device' || req.url === '/token') && req.method === 'POST' && issuer.device) {
      const flow = issuer.device
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        const form = Object.fromEntries(new URLSearchParams(body))
        flow.requests = [...(flow.requests ?? []), { path: req.url as string, ...form }]
        if (req.url === '/device') {
          res.end(
            JSON.stringify({
              device_code: 'dev-1',
              user_code: 'ABCD-EFGH',
              verification_uri: `${issuer.url}/activate`,
              expires_in: 600,
              interval: flow.interval ?? 1,
            })
          )
        } else if (flow.error) {
          res.statusCode = 400
          res.end(JSON.stringify({ error: flow.error }))
        } else if ((flow.pending ?? 0) > 0) {
          flow.pending = (flow.pending ?? 0) - 1
          res.statusCode = 400
          res.end(JSON.stringify({ error: 'authorization_pending' }))
        } else {
          res.end(
            JSON.stringify({
              access_token: flow.token(),
              token_type: 'Bearer',
              expires_in: 3600,
              refresh_token: 'never-stored',
            })
          )
        }
      })
    } else if (req.url === '/redirect') {
      res.statusCode = 307
      res.setHeader('location', `${issuer.url}/token`)
      res.end()
    } else if (req.url === '/jwks') {
      issuer.fetches.jwks++
      res.end(JSON.stringify({ keys: issuer.keys.map((k) => k.jwk) }))
    } else {
      res.statusCode = 404
      res.end('{}')
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  issuer.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  issuer.close = () =>
    new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections()
    })
  return issuer
}
