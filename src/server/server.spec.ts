import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { runProgram } from '../run-program'
import { Environment } from '../executer/environment'
import { readServerConfig, serverConfigSchema } from './server-config'
import { DISCOVERY_PATH, RunningServer, SERVER_PROTOCOL, startServer } from './server'
import { getVersion } from '../version'

const minimal = `
listen: { port: 0 }
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
          issuers: ['https://idp.corp'],
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

  it('answers the health check, and nothing else without a token', async () => {
    await withServer('server-routes', minimal, async (server) => {
      expect(await (await fetch(`${server.url}/healthz`)).json()).toEqual({ status: 'ok' })
      expect((await fetch(`${server.url}/runs`)).status).toBe(404)
      const post = await fetch(`${server.url}${DISCOVERY_PATH}`, { method: 'POST' })
      expect(post.status).toBe(405)
      expect(post.headers.get('allow')).toBe('GET, HEAD')
    })
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
