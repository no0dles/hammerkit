import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { runProgram } from '../run-program'
import { Environment } from '../executer/environment'
import { getSandboxRuntimes, readServerConfig, serverConfigSchema } from './server-config'
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

  it('takes a network ceiling for runs, which local tasks could not keep', () => {
    const issuers = [{ issuer: 'https://idp.corp', audience: 'hammerkit' }]
    expect(serverConfigSchema.parse({ issuers }).runs.network).toBe('open')
    const allow = { network: { allow: ['registry.npmjs.org', '*.githubusercontent.com'] } }
    expect(serverConfigSchema.parse({ issuers, runs: allow }).runs.network).toEqual(allow.network)
    expect(serverConfigSchema.safeParse({ issuers, runs: { network: { allow: ['10.0.0.0/8'] } } }).success).toBe(false)
    const local = serverConfigSchema.safeParse({ issuers, runs: { network: 'none' }, runtimes: ['docker', 'local'] })
    expect(local.success ? [] : local.error.issues).toContainEqual(
      expect.objectContaining({
        path: ['runs', 'network'],
        message: 'the network of a local task can not be limited, allow only the docker runtime with runs.network',
      })
    )
    expect(serverConfigSchema.safeParse({ issuers, runs: { network: 'open' }, runtimes: ['local'] }).success).toBe(true)
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
        sandboxes: [],
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

  it('takes sandboxes as repositories of their own, with a pull or push type per branch pattern', () => {
    const entitlement = { subject: { iss: 'https://idp.corp', sub: 'a' } }
    const parse = (sandboxes: unknown) =>
      serverConfigSchema.safeParse({ ...base, entitlements: [{ ...entitlement, sandboxes }] })
    const parsed = parse([
      { repo: 'github.com/corp/payments', branches: { 'agent/**': 'push', main: 'pull' } },
      { repo: 'github.com/corp/*', branches: { main: 'pull' } },
    ])
    expect(parsed.success && parsed.data.entitlements[0].sandboxes).toEqual([
      { repo: 'github.com/corp/payments', branches: { 'agent/**': 'push', main: 'pull' } },
      { repo: 'github.com/corp/*', branches: { main: 'pull' } },
    ])
    expect(parse(true).success).toBe(false)
    expect(parse([{ repo: 'payments', branches: { main: 'pull' } }]).success).toBe(false)
    // every entry names its branches, each with a type
    expect(parse([{ repo: 'github.com/corp/*' }]).success).toBe(false)
    expect(parse([{ repo: 'github.com/corp/*', branches: {} }]).success).toBe(false)
    expect(parse([{ repo: 'github.com/corp/*', branches: ['main'] }]).success).toBe(false)
    expect(parse([{ repo: 'github.com/corp/*', branches: { main: 'write' } }]).success).toBe(false)
    expect(parse([{ repo: 'github.com/corp/*', branches: { '../main': 'pull' } }]).success).toBe(false)
    // an empty list grants nothing, so the entitlement names nothing either
    expect(parse([]).success).toBe(false)
  })

  it('keeps sandboxes on containers with no network, unless the operator says otherwise', () => {
    const config = serverConfigSchema.parse(base)
    expect(config.sandboxes).toEqual({
      network: 'none',
      env: { allow: [] },
      limits: { count: 5, bytes: '20Gi' },
      total: '500Gi',
    })
    expect(getSandboxRuntimes(config)).toEqual(['docker'])
    expect(
      serverConfigSchema.safeParse({
        ...base,
        sandboxes: { network: { allow: ['registry.npmjs.org', '*.github.com'] } },
      }).success
    ).toBe(true)
  })

  it('starts a server that runs only local tasks, which then runs nothing on sandboxes', () => {
    const config = serverConfigSchema.parse({ ...base, runtimes: ['local'] })
    expect(getSandboxRuntimes(config)).toEqual([])
    expect(
      getSandboxRuntimes(
        serverConfigSchema.parse({ ...base, runtimes: ['local'], sandboxes: { runtimes: ['local'], network: 'open' } })
      )
    ).toEqual(['local'])
  })

  it('keeps the network of sandbox runs within runs.network', () => {
    const within = {
      ...base,
      runs: { network: { allow: ['*.npmjs.org'] } },
      sandboxes: { network: { allow: ['registry.npmjs.org'] } },
    }
    expect(serverConfigSchema.safeParse(within).success).toBe(true)
    const result = serverConfigSchema.safeParse({
      ...base,
      runs: { network: 'none' },
      sandboxes: { network: { allow: ['registry.npmjs.org'] } },
    })
    expect(!result.success && result.error.issues.map((issue) => issue.message)).toContain(
      'runs on sandboxes get at most runs.network (none), not allow registry.npmjs.org'
    )
  })

  it('lets env secrets of sandbox runs read only what runs read', () => {
    const allowed = { ...base, runs: { env: { allow: ['NPM_TOKEN'] } }, sandboxes: { env: { allow: ['NPM_TOKEN'] } } }
    expect(serverConfigSchema.parse(allowed).sandboxes.env.allow).toEqual(['NPM_TOKEN'])
    const result = serverConfigSchema.safeParse({ ...base, sandboxes: { env: { allow: ['NPM_TOKEN'] } } })
    expect(!result.success && result.error.issues[0].message).toBe(
      'NPM_TOKEN is not in runs.env.allow, no run can read it'
    )
  })

  it.each([
    ['a runtime the server does not run on', { runtimes: ['local'], network: 'open' }, /not in runtimes/],
    ['a level that does not exist', { network: 'some' }, /Invalid input/],
    ['a host that is an address', { network: { allow: ['10.0.0.1'] } }, /invalid host/],
    [
      'local tasks under a limited network',
      { runtimes: ['local'], network: 'none' },
      /can not limit the network of a local task/,
    ],
    ['a size that is not one', { limits: { bytes: 'lots' } }, /expected a size/],
  ])('rejects sandboxes with %s', (_name, sandboxes, message) => {
    const result = serverConfigSchema.safeParse({ ...base, sandboxes })
    expect(result.success).toBe(false)
    expect(!result.success && result.error.issues[0].message).toMatch(message)
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

    it('pushes with the secret that reads, and takes no other credential on a source', () => {
      // a source holds one credential; who may push which branches is on the entitlement
      for (const extra of [
        { pushSecret: { from: 'gsm:push', account: 'scm-read' } },
        { push: { secret, branches: ['agent/**'] } },
      ]) {
        expect(
          serverConfigSchema.safeParse({
            ...withProviders,
            sources: [{ match: 'github.com/corp/*', secret, ...extra }],
          }).success
        ).toBe(false)
      }
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

  describe('kubernetes backend', () => {
    const kubernetes = (backend: object, extra: object = {}) =>
      serverConfigSchema.safeParse({ ...base, ...extra, backend: { type: 'kubernetes', ...backend } })
    const message = (result: ReturnType<typeof kubernetes>) => (result.success ? '' : result.error.issues[0].message)

    it('fills in one linux pool and the namespace prefix', () => {
      const result = kubernetes({})
      expect(result.success && result.data.backend).toEqual({
        type: 'kubernetes',
        namespacePrefix: 'hammerkit-',
        pools: [{ name: 'default', platform: { os: 'linux', arch: 'amd64' }, nodeSelector: {}, tolerations: [] }],
        providers: {},
        runRole: 'hammerkit-runs',
        deniedEgress: ['169.254.0.0/16', 'fe80::/10', 'fd00:ec2::/32'],
      })
    })

    it('takes address ranges the pods of runs may not reach', () => {
      expect(kubernetes({ deniedEgress: ['10.0.0.0/8', 'fd00::/8'] }).success).toBe(true)
      for (const range of ['10.0.0.0', '10.0.0.0/33', 'fd00::/129', 'cluster/8', '10.0.0.0/8/1', '']) {
        expect(message(kubernetes({ deniedEgress: [range] })), range).toBe(
          'expected an address range, such as 10.0.0.0/8 or fd00::/8'
        )
      }
    })

    it('reads the secrets of an account as its own credential, never as the node or the image', () => {
      const extra = (account: object) => ({
        secretProviders: { gsm: { command: ['gcloud', '{{ref}}'] } },
        accounts: { dev: { providers: { gsm: { env: {} } }, ...account } },
      })
      const providers = { gsm: { image: 'cloud-sdk:slim' } }
      expect(message(kubernetes({ providers }, extra({})))).toBe(
        'the account dev reads secrets in the Jobs of tasks, name the serviceAccount or secret it reads them as'
      )
      expect(kubernetes({ providers }, extra({ kubernetes: { serviceAccount: 'dev' } })).success).toBe(true)
    })

    it('takes pools, a quota as strings and default resources', () => {
      const result = kubernetes({
        namespace: 'hammerkit',
        pools: [
          { name: 'arm', platform: { os: 'linux', arch: 'arm64' }, toolImage: 'tools:1', tolerations: [{ key: 'b' }] },
        ],
        quota: { 'requests.cpu': 8, 'requests.memory': '16Gi' },
        defaultResources: { requests: { cpu: '250m' } },
      })
      expect(result.success && result.data.backend.type === 'kubernetes' && result.data.backend.quota).toEqual({
        'requests.cpu': '8',
        'requests.memory': '16Gi',
      })
    })

    it('offers linux nodes only, each pool once', () => {
      expect(kubernetes({ pools: [{ name: 'mac', platform: { os: 'macos', arch: 'arm64' } }] }).success).toBe(false)
      expect(message(kubernetes({ pools: [{ name: 'a' }, { name: 'a' }] }))).toBe('the pool a is named twice')
    })

    it('needs the image a provider of an account runs in, as the Job reads the secret', () => {
      const extra = {
        secretProviders: { gsm: { command: ['gcloud', '{{ref}}'] } },
        accounts: { dev: { providers: { gsm: { env: {} } }, kubernetes: { serviceAccount: 'dev' } } },
      }
      expect(message(kubernetes({}, extra))).toBe(
        'the account dev reads gsm in the Jobs of tasks, name the image to run it in'
      )
      expect(kubernetes({ providers: { gsm: { image: 'cloud-sdk:slim' } } }, extra).success).toBe(true)
    })

    it('takes the credentials of an account on a cluster only', () => {
      const accounts = (credentials: object) => ({ accounts: { dev: { kubernetes: credentials } } })
      expect(kubernetes({}, accounts({ serviceAccount: 'dev', audience: 'sts', secret: 'dev-files' })).success).toBe(
        true
      )
      expect(message(kubernetes({}, accounts({})))).toBe('name a serviceAccount, a secret or both')
      expect(message(kubernetes({}, accounts({ secret: 'x', audience: 'sts' })))).toBe(
        'audience is the one of the serviceAccount token'
      )
      expect(serverConfigSchema.safeParse({ ...base, ...accounts({ secret: 'x' }) }).success).toBe(false)
    })

    it('needs a tool image for local tasks', () => {
      expect(message(kubernetes({}, { runtimes: ['docker', 'local'] }))).toBe(
        'local tasks run in the toolImage of a pool, give a pool one or remove local from runtimes'
      )
      expect(kubernetes({ pools: [{ name: 'a', toolImage: 'tools:1' }] }, { runtimes: ['local'] }).success).toBe(true)
    })

    it('limits runs only on a cluster that enforces NetworkPolicies', () => {
      const limited = { runs: { network: 'none' }, runtimes: ['docker'] }
      expect(message(kubernetes({}, limited))).toBe(
        'runs.network limits every task with a NetworkPolicy, set networkPolicy: enforced once the network plugin of the cluster enforces them'
      )
      expect(kubernetes({ networkPolicy: 'enforced' }, limited).success).toBe(true)
    })
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
