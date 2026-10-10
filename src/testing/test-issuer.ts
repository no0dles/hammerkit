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

export interface TestIssuer {
  url: string
  keys: TestKey[]
  // how often the keys were fetched
  fetches: { metadata: number; jwks: number }
  close(): Promise<void>
}

// An OpenID provider on the loopback interface: discovery document and keys.
export async function startTestIssuer(keys: TestKey[]): Promise<TestIssuer> {
  const issuer: TestIssuer = { url: '', keys, fetches: { metadata: 0, jwks: 0 }, close: async () => undefined }
  const server: Server = createServer((req, res) => {
    res.setHeader('content-type', 'application/json')
    if (req.url === '/.well-known/openid-configuration') {
      issuer.fetches.metadata++
      res.end(JSON.stringify({ issuer: issuer.url, jwks_uri: `${issuer.url}/jwks` }))
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
