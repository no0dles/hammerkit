import { constants, createPublicKey, JsonWebKey, KeyObject, verify } from 'crypto'
import { Issuer } from './server-config'

// What a validated token says about its caller. Only these values are matched
// against the entitlements.
export interface Principal {
  iss: string
  sub: string
  groups: string[]
  // the claims with a string value, for matching a CI job's repository or ref
  claims: Record<string, string>
}

// The reason is for the operator's log, never for the caller.
export class TokenError extends Error {}

// Values from a token are written to the operator's log before the signature
// is checked, so they are quoted and cut: they can't start a log line of their own.
export function quote(value: unknown): string {
  return JSON.stringify(String(value).slice(0, 80))
}

type Algorithm = { hash: string; kty: 'RSA' | 'EC'; crv?: string; pss?: boolean }

// Asymmetric algorithms only: there is no shared secret, and `none` and HS*
// are never accepted.
const ALGORITHMS: Record<string, Algorithm> = {
  RS256: { hash: 'sha256', kty: 'RSA' },
  RS384: { hash: 'sha384', kty: 'RSA' },
  RS512: { hash: 'sha512', kty: 'RSA' },
  PS256: { hash: 'sha256', kty: 'RSA', pss: true },
  ES256: { hash: 'sha256', kty: 'EC', crv: 'P-256' },
  ES384: { hash: 'sha384', kty: 'EC', crv: 'P-384' },
  ES512: { hash: 'sha512', kty: 'EC', crv: 'P-521' },
}

const CLOCK_SKEW_SECONDS = 60
const KEYS_TTL_MS = 10 * 60 * 1000
// an unknown kid refreshes the keys, but not more often than this
const REFRESH_COOLDOWN_MS = 60 * 1000
const FETCH_TIMEOUT_MS = 5000
// after a failed load the issuer is left alone for this long, instead of being hit by every request
const FAILURE_BACKOFF_MS = 10 * 1000
// keys that could not be refreshed are still used for this long past their TTL, so a short IdP outage does not lock everyone out
const STALE_KEYS_MS = 60 * 60 * 1000

interface IssuerKeys {
  keys: JsonWebKey[]
  loadedAt: number
}

export interface TokenVerifierOptions {
  fetch?: typeof fetch
  now?: () => number
}

export class TokenVerifier {
  private readonly keys = new Map<string, IssuerKeys>()
  private readonly loading = new Map<string, Promise<IssuerKeys>>()
  private readonly failures = new Map<string, { at: number; error: unknown }>()
  private readonly fetchJson: (url: string) => Promise<unknown>
  private readonly now: () => number

  constructor(
    private readonly issuers: Issuer[],
    options: TokenVerifierOptions = {}
  ) {
    const fetcher = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.fetchJson = async (url) => {
      const response = await fetcher(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
      if (!response.ok) {
        throw new TokenError(`${url} answered ${response.status}`)
      }
      return response.json()
    }
  }

  async verify(token: string): Promise<Principal> {
    const parts = token.split('.')
    if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
      throw new TokenError('not a signed JWT')
    }
    const header = decodeObject(parts[0], 'header')
    const payload = decodeObject(parts[1], 'payload')

    const algorithm = typeof header.alg === 'string' ? ALGORITHMS[header.alg] : undefined
    if (!algorithm) {
      throw new TokenError(`algorithm ${quote(header.alg)} is not accepted`)
    }
    const issuer = this.issuers.find((i) => i.issuer === payload.iss)
    if (!issuer) {
      throw new TokenError(`issuer ${quote(payload.iss)} is not accepted`)
    }

    const jwk = await this.findKey(issuer, algorithm, typeof header.kid === 'string' ? header.kid : undefined)
    const signature = Buffer.from(parts[2], 'base64url')
    const data = Buffer.from(`${parts[0]}.${parts[1]}`)
    const key = createPublicKey({ key: jwk, format: 'jwk' })
    if (!verifySignature(algorithm, data, key, signature)) {
      throw new TokenError('signature does not match')
    }

    return this.readClaims(issuer, payload)
  }

  private readClaims(issuer: Issuer, payload: Record<string, unknown>): Principal {
    const now = this.now() / 1000
    if (typeof payload.exp !== 'number') {
      throw new TokenError('token has no expiry')
    }
    if (payload.exp + CLOCK_SKEW_SECONDS < now) {
      throw new TokenError('token expired')
    }
    if (typeof payload.nbf === 'number' && payload.nbf - CLOCK_SKEW_SECONDS > now) {
      throw new TokenError('token not valid yet')
    }
    const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud]
    if (!audiences.includes(issuer.audience)) {
      throw new TokenError(`token is not meant for ${issuer.audience}`)
    }
    if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
      throw new TokenError('token has no subject')
    }

    const groups = payload[issuer.groupsClaim]
    const claims: Record<string, string> = {}
    for (const [name, value] of Object.entries(payload)) {
      if (typeof value === 'string') {
        claims[name] = value
      }
    }
    return {
      iss: issuer.issuer,
      sub: payload.sub,
      groups: Array.isArray(groups)
        ? groups.filter((g): g is string => typeof g === 'string')
        : typeof groups === 'string'
          ? [groups]
          : [],
      claims,
    }
  }

  private async findKey(issuer: Issuer, algorithm: Algorithm, kid: string | undefined): Promise<JsonWebKey> {
    const known = this.keys.get(issuer.issuer)
    const stale = !known || this.now() - known.loadedAt > KEYS_TTL_MS
    let loaded: IssuerKeys
    if (stale) {
      try {
        loaded = await this.loadKeys(issuer)
      } catch (e) {
        if (!known || this.now() - known.loadedAt > KEYS_TTL_MS + STALE_KEYS_MS) {
          throw e
        }
        loaded = known
      }
    } else {
      loaded = known
    }
    let jwk = pickKey(loaded.keys, algorithm, kid)
    if (!jwk && !stale && this.now() - loaded.loadedAt > REFRESH_COOLDOWN_MS) {
      // the issuer may have rotated its keys since they were cached
      try {
        loaded = await this.loadKeys(issuer)
        jwk = pickKey(loaded.keys, algorithm, kid)
      } catch {
        // keep the cached keys: the token simply has no key we know
      }
    }
    if (!jwk) {
      throw new TokenError(`issuer has no ${algorithm.kty} key${kid ? ` ${quote(kid)}` : ''}`)
    }
    return jwk
  }

  // One load per issuer at a time, and none right after a failed one.
  private loadKeys(issuer: Issuer): Promise<IssuerKeys> {
    const running = this.loading.get(issuer.issuer)
    if (running) {
      return running
    }
    const failure = this.failures.get(issuer.issuer)
    if (failure && this.now() - failure.at < FAILURE_BACKOFF_MS) {
      return Promise.reject(failure.error)
    }
    const load = this.fetchKeys(issuer)
      .then((loaded) => {
        this.failures.delete(issuer.issuer)
        return loaded
      })
      .catch((error) => {
        this.failures.set(issuer.issuer, { at: this.now(), error })
        throw error
      })
      .finally(() => this.loading.delete(issuer.issuer))
    this.loading.set(issuer.issuer, load)
    return load
  }

  private async fetchKeys(issuer: Issuer): Promise<IssuerKeys> {
    const base = issuer.issuer.replace(/\/+$/, '')
    const metadata = (await this.fetchJson(`${base}/.well-known/openid-configuration`)) as Record<string, unknown>
    if (metadata.issuer !== issuer.issuer) {
      throw new TokenError(`issuer metadata names ${quote(metadata.issuer)}`)
    }
    const jwksUri = typeof metadata.jwks_uri === 'string' ? metadata.jwks_uri : ''
    if (!isSecureUrl(jwksUri)) {
      throw new TokenError(`jwks_uri ${quote(jwksUri)} is not https`)
    }
    const jwks = (await this.fetchJson(jwksUri)) as { keys?: JsonWebKey[] }
    const loaded = { keys: Array.isArray(jwks.keys) ? jwks.keys : [], loadedAt: this.now() }
    this.keys.set(issuer.issuer, loaded)
    return loaded
  }
}

function pickKey(keys: JsonWebKey[], algorithm: Algorithm, kid: string | undefined): JsonWebKey | undefined {
  const candidates = keys.filter(
    (jwk) =>
      jwk.kty === algorithm.kty &&
      (jwk as { use?: string }).use !== 'enc' &&
      (algorithm.crv === undefined || jwk.crv === algorithm.crv)
  )
  if (kid !== undefined) {
    return candidates.find((jwk) => (jwk as { kid?: string }).kid === kid)
  }
  // a token without kid is only unambiguous when the issuer has one such key
  return candidates.length === 1 ? candidates[0] : undefined
}

function verifySignature(algorithm: Algorithm, data: Buffer, key: KeyObject, signature: Buffer): boolean {
  if (algorithm.kty === 'EC') {
    return verify(algorithm.hash, data, { key, dsaEncoding: 'ieee-p1363' }, signature)
  }
  if (algorithm.pss) {
    return verify(
      algorithm.hash,
      data,
      { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_DIGEST },
      signature
    )
  }
  return verify(algorithm.hash, data, key, signature)
}

function decodeObject(part: string, what: string): Record<string, unknown> {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'))
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return value
    }
  } catch {
    // reported below
  }
  throw new TokenError(`token ${what} is not a JSON object`)
}

function isSecureUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      url.protocol === 'https:' ||
      (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))
    )
  } catch {
    return false
  }
}
