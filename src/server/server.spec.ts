import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { runProgram } from '../run-program'
import { Environment } from '../executer/environment'
import { readServerConfig, serverConfigSchema } from './server-config'
import { DISCOVERY_PATH, RunningServer, SERVER_PROTOCOL, startServer } from './server'
import { getVersion } from '../version'
import { HOST_ENV_YAML } from '../testing/host-env'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'

const minimal = `
${HOST_ENV_YAML}listen: { port: 0 }
issuers:
  - { issuer: https://idp.corp, audience: hammerkit }
`

async function withServerConfig(
  name: string,
  yaml: string,
  fn: (environment: Environment, configFile: string) => Promise<void>
): Promise<void> {
  await createTestCase(name, {}).setup(async (cwd, environment) => {
    const file = join(cwd, 'server.yaml')
    writeFileSync(file, yaml)
    await fn(environment, file)
  })
}

describe('server config', () => {
  it('fills in the defaults', async () => {
    await withServerConfig('server-config-defaults', minimal, async (env, file) => {
      const config = await readServerConfig(env, file)
      expect(config.listen).toEqual({ host: '127.0.0.1', port: 0 })
      expect(config.backend).toEqual({ type: 'host' })
      expect(config.behindTlsProxy).toBe(false)
    })
  })

  it('needs an issuer, as OAuth is the only way in', async () => {
    await withServerConfig('server-config-no-issuer', 'listen: { port: 0 }\n', async (env, file) => {
      await expect(readServerConfig(env, file)).rejects.toThrow(/invalid .*server.yaml: issuers/)
    })
  })

  it('rejects unknown keys', async () => {
    await withServerConfig('server-config-typo', `${minimal}listn: {}\n`, async (env, file) => {
      await expect(readServerConfig(env, file)).rejects.toThrow('Unrecognized key')
    })
  })

  it('reports a missing or malformed file', async () => {
    await withServerConfig('server-config-bad-file', 'a: [', async (env, file) => {
      await expect(readServerConfig(env, file)).rejects.toThrow('unable to read')
      await expect(readServerConfig(env, `${file}.missing`)).rejects.toThrow('no such file')
    })
  })

  it('accepts plain http only on loopback or behind a TLS proxy', () => {
    const issuers = [{ issuer: 'https://idp.corp', audience: 'hammerkit' }]
    const open = serverConfigSchema.safeParse({ issuers, listen: { host: '0.0.0.0' } })
    expect(open.success).toBe(false)
    expect(serverConfigSchema.safeParse({ issuers, listen: { host: '0.0.0.0' }, behindTlsProxy: true }).success).toBe(
      true
    )
    expect(
      serverConfigSchema.safeParse({
        issuers,
        listen: { host: '0.0.0.0' },
        tls: { cert: 'c.pem', key: 'k.pem' },
      }).success
    ).toBe(true)
    expect(serverConfigSchema.safeParse({ issuers, listen: { host: 'localhost' } }).success).toBe(true)
  })

  it('takes only the platforms it knows', () => {
    const issuers = [{ issuer: 'https://idp.corp', audience: 'hammerkit' }]
    const backend = { type: 'host', platform: { os: 'plan9', arch: 'amd64' } }
    expect(serverConfigSchema.safeParse({ issuers, backend }).success).toBe(false)
  })
})

describe('server', () => {
  async function withServer(name: string, yaml: string, fn: (server: RunningServer) => Promise<void>): Promise<void> {
    await withServerConfig(name, yaml, async (env, file) => {
      const server = await startServer(await readServerConfig(env, file), env)
      try {
        await fn(server)
      } finally {
        await server.close()
      }
    })
  }

  it('publishes what it is and whom it trusts without a token', async () => {
    await withServer(
      'server-discovery',
      `${minimal}backend: { type: host, platform: { os: macos, arch: arm64 } }\n`,
      async (server) => {
        const response = await fetch(`${server.url}${DISCOVERY_PATH}`)
        expect(response.status).toBe(200)
        expect(response.headers.get('cache-control')).toBe('no-store')
        expect(await response.json()).toEqual({
          name: 'hammerkit',
          version: getVersion(),
          protocol: SERVER_PROTOCOL,
          issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit', scope: 'openid' }],
          backend: { type: 'host', platform: { os: 'macos', arch: 'arm64' } },
        })
      }
    )
  })

  it('detects the platform of the machine when none is configured', async () => {
    await withServer('server-detect', minimal, async (server) => {
      const { backend } = (await (await fetch(`${server.url}${DISCOVERY_PATH}`)).json()) as any
      expect(['linux', 'macos', 'windows']).toContain(backend.platform.os)
      expect(['amd64', 'arm64']).toContain(backend.platform.arch)
    })
  })

  it('answers the health check, and refuses everything else without a token', async () => {
    await withServer('server-routes', minimal, async (server) => {
      expect(await (await fetch(`${server.url}/healthz`)).json()).toEqual({ status: 'ok' })
      expect((await fetch(`${server.url}/runs`)).status).toBe(401)
      const post = await fetch(`${server.url}${DISCOVERY_PATH}`, { method: 'POST' })
      expect(post.status).toBe(405)
      expect(post.headers.get('allow')).toBe('GET, HEAD')
    })
  })

  it('refuses to start when the allowlist hides PATH from the tasks', async () => {
    const hidden = minimal.replace(/runs:.*\n/, '')
    await withServerConfig('server-no-path', hidden, async (env, file) => {
      await expect(startServer(await readServerConfig(env, file), env)).rejects.toThrow(
        'runs.env.allow has no PATH, tasks could not find their tools'
      )
    })
    // a fixed PATH is as good
    await withServer(
      'server-fixed-path',
      hidden.replace('issuers:', 'runs: { env: { set: { PATH: /usr/bin } } }\nissuers:'),
      async (server) => {
        expect(server.url).toMatch(/^http/)
      }
    )
  })

  it('warns when the local runtime is allowed, and says nothing otherwise', async () => {
    const lines: string[] = []
    await withServerConfig('server-warn-local', `${minimal}runtimes: [docker, local]\n`, async (env, file) => {
      const server = await startServer(await readServerConfig(env, file), env, { log: (line) => lines.push(line) })
      await server.close()
    })
    expect(lines.join('\n')).toContain('the local runtime is allowed')
    const quiet: string[] = []
    await withServerConfig('server-no-warn', minimal, async (env, file) => {
      const server = await startServer(await readServerConfig(env, file), env, { log: (line) => quiet.push(line) })
      await server.close()
    })
    expect(quiet).toEqual([])
  })

  it('refuses to start on a port that is taken', async () => {
    await withServer('server-port-taken', minimal, async (server) => {
      const port = Number(new URL(server.url).port)
      await withServerConfig('server-port-taken-2', minimal.replace('port: 0', `port: ${port}`), async (env, file) => {
        await expect(startServer(await readServerConfig(env, file), env)).rejects.toThrow('EADDRINUSE')
      })
    })
  })
})

describe('server authentication', () => {
  const policy = `
accounts:
  op-payments-dev: { description: "Payments, test secrets" }
  op-payments-prod: {}
  op-web-dev: {}
entitlements:
  - subject: { iss: ISSUER, sub: alice }
    accounts: { op-payments-dev: use, op-payments-prod: request }
    repos: [github.com/corp/payments]
    builds: run
  - group: { iss: ISSUER, name: eng-web }
    accounts: { op-web-dev: use }
`

  async function withIssuer(
    name: string,
    fn: (server: RunningServer, token: (claims?: Record<string, unknown>) => string, log: string[]) => Promise<void>
  ): Promise<void> {
    const key = createTestKey('ES256', 'k1')
    const idp = await startTestIssuer([key])
    try {
      const yaml = `${HOST_ENV_YAML}listen: { port: 0 }\nissuers:\n  - { issuer: "${
        idp.url
      }", audience: hammerkit }\n${policy.replace(/ISSUER/g, `"${idp.url}"`)}`
      await withServerConfig(name, yaml, async (env, file) => {
        const log: string[] = []
        const server = await startServer(await readServerConfig(env, file), env, { log: (line) => log.push(line) })
        try {
          const token = (claims: Record<string, unknown> = {}) =>
            signToken(key, {
              iss: idp.url,
              sub: 'alice',
              aud: 'hammerkit',
              exp: Math.floor(Date.now() / 1000) + 300,
              ...claims,
            })
          await fn(server, token, log)
        } finally {
          await server.close()
        }
      })
    } finally {
      await idp.close()
    }
  }

  const me = (server: RunningServer, token?: string) =>
    fetch(`${server.url}/v1/me`, { headers: token ? { authorization: `Bearer ${token}` } : {} })

  it('tells a caller which accounts the token entitles them to', async () => {
    await withIssuer('server-me', async (server, token, log) => {
      const response = await me(server, token({ groups: ['eng-web'] }))
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        iss: expect.stringMatching(/^http/),
        sub: 'alice',
        accounts: [
          { name: 'op-payments-dev', level: 'use' },
          { name: 'op-payments-prod', level: 'request' },
          { name: 'op-web-dev', level: 'use' },
        ],
        repos: ['github.com/corp/payments'],
        builds: 'run',
      })
      expect(log.join('\n')).toMatch(
        /grant iss=\S+ sub=alice accounts=\[op-payments-dev:use,op-payments-prod:request,op-web-dev:use\] entitlements=\[0,1\]/
      )
    })
  })

  it('lists the accounts of the caller with their level and what the operator says about them', async () => {
    await withIssuer('server-accounts', async (server, token) => {
      const response = await fetch(`${server.url}/v1/accounts`, {
        headers: { authorization: `Bearer ${token({ groups: ['eng-web'] })}` },
      })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({
        accounts: [
          {
            name: 'op-payments-dev',
            description: 'Payments, test secrets',
            level: 'use',
            sources: ['upload', 'ref'],
          },
          { name: 'op-payments-prod', level: 'request', sources: ['upload', 'ref'] },
          { name: 'op-web-dev', level: 'use', sources: ['upload', 'ref'] },
        ],
      })
      // only what the caller has: nobody else's accounts are listed
      const bob = await fetch(`${server.url}/v1/accounts`, {
        headers: { authorization: `Bearer ${token({ sub: 'bob' })}` },
      })
      expect(await bob.json()).toEqual({ accounts: [] })
      const wrong = await fetch(`${server.url}/v1/accounts`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token()}` },
      })
      expect(wrong.status).toBe(405)
    })
  })

  it('gives a caller without an entitlement no account', async () => {
    await withIssuer('server-me-denied', async (server, token) => {
      const response = await me(server, token({ sub: 'bob' }))
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ sub: 'bob', accounts: [], repos: [], builds: null })
    })
  })

  it('refuses a missing, malformed or invalid token without saying why', async () => {
    await withIssuer('server-me-refused', async (server, token, log) => {
      for (const candidate of [undefined, 'garbage', token({ exp: 1 }), token({ aud: 'other' })]) {
        const response = await me(server, candidate)
        expect(response.status).toBe(401)
        expect(response.headers.get('www-authenticate')).toBe('Bearer error="invalid_token"')
        expect(await response.json()).toEqual({ error: 'invalid token' })
      }
      expect(log.filter((l) => l.startsWith('deny'))).toHaveLength(4)
      expect(log.join('\n')).toContain('token expired')
    })
  })

  it('writes nothing a caller sent to the log as a line of its own', async () => {
    await withIssuer('server-log-forging', async (server, token, log) => {
      const forged = 'x\n2026 grant iss=https://idp.example sub=admin'
      const response = await me(server, token({ iss: forged }))
      expect(response.status).toBe(401)
      expect(log).toHaveLength(1)
      expect(log[0]).not.toMatch(/\p{Cc}/u)
    })
  })

  it('still serves the discovery document without a token', async () => {
    await withIssuer('server-open-discovery', async (server) => {
      expect((await fetch(`${server.url}${DISCOVERY_PATH}`)).status).toBe(200)
    })
  })

  it('answers 404 for an unknown path once the caller is known', async () => {
    await withIssuer('server-unknown-path', async (server, token) => {
      const response = await fetch(`${server.url}/v1/nothing`, { headers: { authorization: `Bearer ${token()}` } })
      expect(response.status).toBe(404)
    })
  })
})

describe('server config policy', () => {
  const base = {
    issuers: [{ issuer: 'https://idp.corp', audience: 'hammerkit' }],
    accounts: { a: {}, b: {}, c: {} },
  }

  it('takes an entitlement for one subject, group or claims', () => {
    const entitlements = [
      { subject: { iss: 'https://idp.corp', sub: 'alice' }, accounts: { a: 'use' }, builds: 'publish' },
      {
        group: { iss: 'https://idp.corp', name: 'eng' },
        accounts: { a: 'use', b: 'request' },
        repos: ['github.com/corp/*', 'gitlab.corp.com/platform/**'],
      },
      { claims: { iss: 'https://idp.corp', match: { repository: 'corp/x' } }, accounts: { c: 'use' } },
      { subject: { iss: 'https://idp.corp', sub: 'agent' }, builds: 'propose' },
    ]
    expect(serverConfigSchema.safeParse({ ...base, entitlements }).success).toBe(true)
  })

  it.each([
    ['nobody', { accounts: { a: 'use' } }],
    [
      'two kinds of caller',
      {
        subject: { iss: 'https://idp.corp', sub: 'a' },
        group: { iss: 'https://idp.corp', name: 'g' },
        accounts: { a: 'use' },
      },
    ],
    ['no accounts and no builds level', { subject: { iss: 'https://idp.corp', sub: 'a' }, accounts: {} }],
    ['an account that is not defined', { subject: { iss: 'https://idp.corp', sub: 'a' }, accounts: { typo: 'use' } }],
    ['a level that does not exist', { subject: { iss: 'https://idp.corp', sub: 'a' }, accounts: { a: 'admin' } }],
    ['an old account list', { subject: { iss: 'https://idp.corp', sub: 'a' }, accounts: ['a'] }],
    ['an old default', { subject: { iss: 'https://idp.corp', sub: 'a' }, accounts: { a: 'use' }, default: 'a' }],
    ['names of build files', { subject: { iss: 'https://idp.corp', sub: 'a' }, publish: ['payments'] }],
    ['a builds level that does not exist', { subject: { iss: 'https://idp.corp', sub: 'a' }, builds: 'admin' }],
    [
      'a repo that is not host/path',
      { subject: { iss: 'https://idp.corp', sub: 'a' }, builds: 'run', repos: ['corp'] },
    ],
    ['claims that match anything', { claims: { iss: 'https://idp.corp', match: {} }, accounts: { a: 'use' } }],
    ['an issuer that is not accepted', { subject: { iss: 'https://other', sub: 'a' }, accounts: { a: 'use' } }],
  ])('rejects %s', (_name, entitlement) => {
    expect(serverConfigSchema.safeParse({ ...base, entitlements: [entitlement] }).success).toBe(false)
  })

  it('names the account that is not defined, and the ones that are', () => {
    const result = serverConfigSchema.safeParse({
      ...base,
      entitlements: [{ subject: { iss: 'https://idp.corp', sub: 'a' }, accounts: { typo: 'use' } }],
    })
    expect(result.success).toBe(false)
    expect(JSON.stringify(result.success ? '' : result.error.issues)).toContain(
      'unknown account typo, accounts: a, b, c'
    )
  })

  it('checks that the providers an account is read with are declared', () => {
    const bad = { ...base, accounts: { a: { providers: { gsm: { env: {} } } } } }
    expect(serverConfigSchema.safeParse(bad).success).toBe(false)
    const good = { ...bad, secretProviders: { gsm: { command: ['gcloud', '{{ref}}'] } } }
    expect(serverConfigSchema.safeParse(good).success).toBe(true)
  })

  describe('sources', () => {
    const withProviders = {
      ...base,
      secretProviders: { gsm: { command: ['gcloud', '{{ref}}'] } },
      accounts: { 'scm-read': { providers: { gsm: { env: {} } } }, a: {} },
    }
    const secret = { from: 'gsm:github-token', account: 'scm-read' }

    it('takes patterns of repositories with the secret that reads them', () => {
      const parsed = serverConfigSchema.safeParse({
        ...withProviders,
        sources: [
          { match: 'github.com/corp/*', secret },
          { match: 'gitlab.corp.com/platform/**', secret: { ...secret, username: 'oauth2' } },
          { match: 'github.com/public/*' },
        ],
      })
      expect(parsed.success).toBe(true)
      expect(parsed.success && parsed.data.sources[0].secret?.username).toBe('x-access-token')
    })

    it.each([
      ['a url', [{ match: 'https://user:pw@github.com/corp/x' }]],
      ['a name without a path', [{ match: 'payments' }]],
      ['a map per build file, as before', { payments: { git: 'git@github.com:corp/payments.git' } }],
      ['an account that does not exist', [{ match: 'github.com/corp/*', secret: { ...secret, account: 'nope' } }]],
      [
        'an account without credentials for the provider',
        [{ match: 'github.com/corp/*', secret: { ...secret, account: 'a' } }],
      ],
      ['a provider that is not declared', [{ match: 'github.com/corp/*', secret: { ...secret, from: 'op:x' } }]],
      ['a secret without a provider', [{ match: 'github.com/corp/*', secret: { ...secret, from: 'token' } }]],
    ])('rejects %s', (_name, sources) => {
      expect(serverConfigSchema.safeParse({ ...withProviders, sources }).success).toBe(false)
    })

    it('keeps the account that reads repositories away from entitlements', () => {
      const result = serverConfigSchema.safeParse({
        ...withProviders,
        sources: [{ match: 'github.com/corp/*', secret }],
        entitlements: [{ subject: { iss: 'https://idp.corp', sub: 'a' }, accounts: { 'scm-read': 'use' } }],
      })
      expect(result.success).toBe(false)
      expect(JSON.stringify(result.success ? '' : result.error.issues)).toContain(
        'the account scm-read reads the sources, no entitlement may name it'
      )
    })
  })

  it('only restricts refs for an account that takes nothing but a ref', () => {
    const account = (a: object) => serverConfigSchema.safeParse({ ...base, accounts: { a } }).success
    expect(account({ source: ['ref'], refs: ['main', 'release/*'] })).toBe(true)
    expect(account({ refs: ['main'] })).toBe(false)
    expect(account({ source: ['upload', 'ref'], refs: ['main'] })).toBe(false)
  })

  it('accepts issuers over https, and http only on loopback', () => {
    const parse = (issuer: string) => serverConfigSchema.safeParse({ issuers: [{ issuer, audience: 'hammerkit' }] })
    expect(parse('https://idp.corp').success).toBe(true)
    expect(parse('http://127.0.0.1:9000').success).toBe(true)
    expect(parse('http://idp.corp').success).toBe(false)
    expect(parse('idp.corp').success).toBe(false)
  })
})

describe('server command', () => {
  it('serves until it is interrupted', async () => {
    await withServerConfig('server-command', minimal, async (env, file) => {
      const out = memoryStream()
      env.stdout = out.stream
      const finished = runProgram(env, ['hammerkit', 'server', '--config', file], true)

      const url = await new Promise<string>((resolve, reject) => {
        const started = Date.now()
        const timer = setInterval(() => {
          const match = /listening on (\S+)/.exec(out.read())
          if (match) {
            clearInterval(timer)
            resolve(match[1])
          } else if (Date.now() - started > 5000) {
            clearInterval(timer)
            reject(new Error(`server did not start: ${out.read()}`))
          }
        }, 20)
      })
      expect((await fetch(`${url}/healthz`)).status).toBe(200)

      env.abortCtrl.abort()
      await finished
      expect(out.read()).toContain('hammerkit server stopped')
    })
  })

  it('needs a config', async () => {
    await createTestCase('server-command-no-config', {}).setup(async (_cwd, env) => {
      const previous = env.processEnvs.HAMMERKIT_SERVER_CONFIG
      delete env.processEnvs.HAMMERKIT_SERVER_CONFIG
      await expect(runProgram(env, ['hammerkit', 'server'], true)).rejects.toThrow('pass the server config')
      env.processEnvs.HAMMERKIT_SERVER_CONFIG = previous
    })
  })
})
