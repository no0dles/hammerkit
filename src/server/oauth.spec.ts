import { createTestKey, signToken, startTestIssuer, TestIssuer, TestKey } from '../testing/test-issuer'
import { TokenVerifier } from './oauth'
import { Issuer } from './server-config'

const NOW = 1_800_000_000_000

let issuer: TestIssuer
let key: TestKey

beforeAll(async () => {
  key = createTestKey('RS256', 'k1')
  issuer = await startTestIssuer([key])
})

afterAll(async () => {
  await issuer.close()
})

function verifier(options: Partial<Issuer> = {}, now = NOW) {
  return new TokenVerifier(
    [{ issuer: issuer.url, audience: 'hammerkit', groupsClaim: 'groups', scope: 'openid', ...options }],
    {
      now: () => now,
    }
  )
}

function claims(extra: Record<string, unknown> = {}) {
  return { iss: issuer.url, sub: 'alice', aud: 'hammerkit', exp: NOW / 1000 + 300, ...extra }
}

describe('TokenVerifier', () => {
  it('accepts a signed token and reads who the caller is', async () => {
    const principal = await verifier().verify(
      signToken(key, claims({ groups: ['eng-web', 7], repository: 'corp/payments', admin: true }))
    )
    expect(principal).toMatchObject({ iss: issuer.url, sub: 'alice', groups: ['eng-web'] })
    expect(principal.claims.repository).toBe('corp/payments')
    expect(principal.claims.admin).toBeUndefined()
  })

  it.each(['RS256', 'PS256', 'ES256'] as const)('verifies %s signatures', async (alg) => {
    const other = createTestKey(alg, `k-${alg}`)
    const idp = await startTestIssuer([other])
    try {
      const v = new TokenVerifier(
        [{ issuer: idp.url, audience: 'hammerkit', groupsClaim: 'groups', scope: 'openid' }],
        {
          now: () => NOW,
        }
      )
      const principal = await v.verify(signToken(other, { ...claims(), iss: idp.url }))
      expect(principal.sub).toBe('alice')
    } finally {
      await idp.close()
    }
  })

  it('reads the groups from the configured claim, a string counting as one group', async () => {
    const principal = await verifier({ groupsClaim: 'roles' }).verify(signToken(key, claims({ roles: 'release' })))
    expect(principal.groups).toEqual(['release'])
  })

  it('rejects a token signed by another key', async () => {
    const forged = createTestKey('RS256', 'k1')
    await expect(verifier().verify(signToken(forged, claims()))).rejects.toThrow('signature does not match')
  })

  it('rejects a token that was changed after signing', async () => {
    const [head, , signature] = signToken(key, claims()).split('.')
    const payload = Buffer.from(JSON.stringify(claims({ sub: 'mallory' }))).toString('base64url')
    await expect(verifier().verify(`${head}.${payload}.${signature}`)).rejects.toThrow('signature does not match')
  })

  it('rejects none and shared-secret algorithms', async () => {
    const head = (alg: string) => Buffer.from(JSON.stringify({ alg, kid: 'k1' })).toString('base64url')
    const body = Buffer.from(JSON.stringify(claims())).toString('base64url')
    await expect(verifier().verify(`${head('none')}.${body}.AAAA`)).rejects.toThrow('not accepted')
    await expect(verifier().verify(`${head('HS256')}.${body}.AAAA`)).rejects.toThrow('not accepted')
  })

  it('rejects an EC token against an RSA key', async () => {
    const ec = createTestKey('ES256', 'k1')
    await expect(verifier().verify(signToken(ec, claims()))).rejects.toThrow('has no EC key "k1"')
  })

  it('rejects an issuer that is not configured', async () => {
    await expect(verifier().verify(signToken(key, claims({ iss: 'https://evil.example' })))).rejects.toThrow(
      'issuer "https://evil.example" is not accepted'
    )
  })

  it('rejects the wrong audience, also in a list', async () => {
    await expect(verifier().verify(signToken(key, claims({ aud: 'other' })))).rejects.toThrow('not meant for hammerkit')
    await expect(verifier().verify(signToken(key, claims({ aud: ['other'] })))).rejects.toThrow('not meant for')
    expect((await verifier().verify(signToken(key, claims({ aud: ['other', 'hammerkit'] })))).sub).toBe('alice')
  })

  it('checks expiry and not-before with a minute of clock skew', async () => {
    await expect(verifier().verify(signToken(key, claims({ exp: NOW / 1000 - 120 })))).rejects.toThrow('expired')
    expect((await verifier().verify(signToken(key, claims({ exp: NOW / 1000 - 30 })))).sub).toBe('alice')
    await expect(verifier().verify(signToken(key, claims({ nbf: NOW / 1000 + 120 })))).rejects.toThrow('not valid yet')
    const noExpiry = claims()
    delete (noExpiry as Record<string, unknown>).exp
    await expect(verifier().verify(signToken(key, noExpiry))).rejects.toThrow('no expiry')
  })

  it('needs a subject', async () => {
    const noSub = claims()
    delete (noSub as Record<string, unknown>).sub
    await expect(verifier().verify(signToken(key, noSub))).rejects.toThrow('no subject')
  })

  it('rejects what is not a JWT', async () => {
    await expect(verifier().verify('abc')).rejects.toThrow('not a signed JWT')
    await expect(verifier().verify('a..c')).rejects.toThrow('not a signed JWT')
    await expect(verifier().verify('e30.bm90LWpzb24.AAAA')).rejects.toThrow('not a JSON object')
  })

  it('caches the keys, and refetches them once when a key it does not know shows up', async () => {
    const idp = await startTestIssuer([createTestKey('RS256', 'old')])
    try {
      let now = NOW
      const v = new TokenVerifier(
        [{ issuer: idp.url, audience: 'hammerkit', groupsClaim: 'groups', scope: 'openid' }],
        {
          now: () => now,
        }
      )
      const old = idp.keys[0]
      await v.verify(signToken(old, { ...claims(), iss: idp.url }))
      await v.verify(signToken(old, { ...claims(), iss: idp.url }))
      expect(idp.fetches.jwks).toBe(1)

      // the issuer rotates; right after loading, an unknown kid is not refetched
      const rotated = createTestKey('RS256', 'new')
      idp.keys = [rotated]
      await expect(v.verify(signToken(rotated, { ...claims(), iss: idp.url }))).rejects.toThrow('no RSA key "new"')
      expect(idp.fetches.jwks).toBe(1)

      now += 2 * 60 * 1000
      expect((await v.verify(signToken(rotated, { ...claims(), exp: now / 1000 + 300, iss: idp.url }))).sub).toBe(
        'alice'
      )
      expect(idp.fetches.jwks).toBe(2)
    } finally {
      await idp.close()
    }
  })

  it('refuses metadata that names another issuer', async () => {
    const v = new TokenVerifier(
      [{ issuer: issuer.url, audience: 'hammerkit', groupsClaim: 'groups', scope: 'openid' }],
      {
        now: () => NOW,
        fetch: (async (url: string) =>
          new Response(JSON.stringify({ issuer: 'https://other.example', jwks_uri: `${url}/jwks` }))) as typeof fetch,
      }
    )
    await expect(v.verify(signToken(key, claims()))).rejects.toThrow('issuer metadata names "https://other.example"')
  })

  it('refuses keys that are not served over https', async () => {
    const v = new TokenVerifier(
      [{ issuer: issuer.url, audience: 'hammerkit', groupsClaim: 'groups', scope: 'openid' }],
      {
        now: () => NOW,
        fetch: (async () =>
          new Response(JSON.stringify({ issuer: issuer.url, jwks_uri: 'http://keys.example/jwks' }))) as typeof fetch,
      }
    )
    await expect(v.verify(signToken(key, claims()))).rejects.toThrow('is not https')
  })

  it('reports an issuer that does not answer', async () => {
    const v = new TokenVerifier(
      [{ issuer: issuer.url, audience: 'hammerkit', groupsClaim: 'groups', scope: 'openid' }],
      {
        now: () => NOW,
        fetch: (async () => new Response('{}', { status: 503 })) as typeof fetch,
      }
    )
    await expect(v.verify(signToken(key, claims()))).rejects.toThrow('answered 503')
  })

  it('quotes what a token says, so it can not forge a log line', async () => {
    const forged = 'x\n2026 grant iss=https://idp.example sub=admin'
    const error = await verifier()
      .verify(signToken(key, { ...claims(), iss: forged }))
      .catch((e) => e)
    expect(error.message).not.toContain('\n')
    expect(error.message).toContain('\\n2026 grant')
  })

  it('loads the keys once for concurrent requests', async () => {
    const idp = await startTestIssuer([createTestKey('RS256', 'k')])
    try {
      const v = new TokenVerifier(
        [{ issuer: idp.url, audience: 'hammerkit', groupsClaim: 'groups', scope: 'openid' }],
        {
          now: () => NOW,
        }
      )
      const token = signToken(idp.keys[0], { ...claims(), iss: idp.url })
      await Promise.all(Array.from({ length: 10 }, () => v.verify(token)))
      expect(idp.fetches.metadata).toBe(1)
      expect(idp.fetches.jwks).toBe(1)
    } finally {
      await idp.close()
    }
  })

  it('leaves a failing issuer alone for a while, and keeps using old keys while it is down', async () => {
    let now = NOW
    let down = false
    let calls = 0
    const v = new TokenVerifier(
      [{ issuer: issuer.url, audience: 'hammerkit', groupsClaim: 'groups', scope: 'openid' }],
      {
        now: () => now,
        fetch: (async (url: string, init?: RequestInit) => {
          calls++
          if (down) {
            return new Response('{}', { status: 503 })
          }
          return fetch(url, init)
        }) as typeof fetch,
      }
    )
    const token = () => signToken(key, { ...claims(), exp: now / 1000 + 300 })
    await v.verify(token())
    expect(calls).toBe(2)

    // the ttl is over and the issuer is down: the old keys still work
    down = true
    now += 11 * 60 * 1000
    expect((await v.verify(token())).sub).toBe('alice')
    expect(calls).toBe(3)
    // and it is not asked again right away
    await v.verify(token())
    expect(calls).toBe(3)

    // after a long outage the keys are no longer trusted
    now += 2 * 60 * 60 * 1000
    await expect(v.verify(token())).rejects.toThrow('answered 503')
  })
})
