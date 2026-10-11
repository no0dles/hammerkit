import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'
import { hashBundle } from '../remote/bundle'
import { readServerConfig } from './server-config'
import { RunningServer, startServer } from './server'

const policy = `
entitlements:
  - subject: { iss: ISSUER, sub: ci }
    publish: ['*']
  - subject: { iss: ISSUER, sub: alice }
    accounts: [op-payments-dev]
    publish: [payments]
  - subject: { iss: ISSUER, sub: bob }
    accounts: [op-web-dev]
`

interface JsonResponse extends Response {
  json(): Promise<any>
}

async function withApi(
  name: string,
  fn: (api: {
    server: RunningServer
    log: string[]
    call: (method: string, path: string, sub?: string | null, body?: unknown) => Promise<JsonResponse>
    restart: () => Promise<void>
  }) => Promise<void>
) {
  const key = createTestKey('ES256', 'k1')
  const idp = await startTestIssuer([key])
  try {
    await createTestCase(name, {}).setup(async (cwd, env) => {
      const file = join(cwd, 'server.yaml')
      writeFileSync(
        file,
        `listen: { port: 0 }\nstorage: { directory: "${join(cwd, 'data')}" }\nissuers:\n  - { issuer: "${
          idp.url
        }", audience: hammerkit }\n${policy.replace(/ISSUER/g, `"${idp.url}"`)}`
      )
      const log: string[] = []
      let server = await startServer(await readServerConfig(env, file), env, { log: (line) => log.push(line) })
      const api = {
        get server() {
          return server
        },
        log,
        call: ((method: string, path: string, sub: string | null = 'alice', body?: unknown) =>
          fetch(`${server.url}${path}`, {
            method,
            headers: {
              ...(sub === null
                ? {}
                : {
                    authorization: `Bearer ${signToken(key, {
                      iss: idp.url,
                      sub,
                      aud: 'hammerkit',
                      exp: Math.floor(Date.now() / 1000) + 300,
                    })}`,
                  }),
              ...(body === undefined ? {} : { 'content-type': 'application/json' }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })) as (method: string, path: string, sub?: string | null, body?: unknown) => Promise<JsonResponse>,
        restart: async () => {
          await server.close()
          server = await startServer(await readServerConfig(env, file), env, { log: (line) => log.push(line) })
        },
      }
      try {
        await fn(api)
      } finally {
        await server.close()
      }
    })
  } finally {
    await idp.close()
  }
}

const files = { '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo build]\n  test:\n    cmds: [echo test]\n' }
const bundle = { files }

describe('definitions api', () => {
  it('needs a token', async () => {
    await withApi('definitions-api-auth', async (api) => {
      expect((await api.call('PUT', '/v1/definitions/payments', null, bundle)).status).toBe(401)
      expect((await api.call('GET', '/v1/definitions', null)).status).toBe(401)
    })
  })

  it('publishes a build file and tells its version, which is the hash of its files', async () => {
    await withApi('definitions-api-publish', async (api) => {
      const response = await api.call('PUT', '/v1/definitions/payments', 'alice', bundle)
      expect(response.status).toBe(201)
      const version = await response.json()
      expect(version).toMatchObject({
        name: 'payments',
        hash: hashBundle({ entry: '.hammerkit.yaml', files }),
        entry: '.hammerkit.yaml',
        tasks: ['build', 'test'],
        services: [],
        created: true,
        publishedBy: { sub: 'alice' },
      })
      expect(api.log.join('\n')).toContain(`publish payments ${version.hash}`)

      // the same files again are the same version
      const again = await api.call('PUT', '/v1/definitions/payments', 'alice', bundle)
      expect(again.status).toBe(200)
      expect(await again.json()).toMatchObject({ hash: version.hash, created: false })
    })
  })

  it('lets only who has the permission publish, and only the build files it names', async () => {
    await withApi('definitions-api-permission', async (api) => {
      // running something is not publishing it
      const bob = await api.call('PUT', '/v1/definitions/web', 'bob', bundle)
      expect(bob.status).toBe(403)
      expect((await bob.json()).error).toBe('you may not publish web')
      expect((await api.call('PUT', '/v1/definitions/web', 'alice', bundle)).status).toBe(403)
      expect((await api.call('PUT', '/v1/definitions/payments', 'nobody', bundle)).status).toBe(403)
      expect((await api.call('PUT', '/v1/definitions/web', 'ci', bundle)).status).toBe(201)
      expect((await api.call('PUT', '/v1/definitions/payments', 'ci', bundle)).status).toBe(201)
      expect(api.log.join('\n')).toContain('refuse publish')
    })
  })

  it('lists versions, newest first, and reads one by hash or as latest', async () => {
    await withApi('definitions-api-read', async (api) => {
      const one = await (await api.call('PUT', '/v1/definitions/payments', 'alice', bundle)).json()
      await new Promise((resolve) => setTimeout(resolve, 5))
      const next = {
        files: { '.hammerkit.yaml': `${files['.hammerkit.yaml']}  deploy:\n    cmds: [echo deploy]\n` },
      }
      const two = await (await api.call('PUT', '/v1/definitions/payments', 'alice', next)).json()

      const all = await (await api.call('GET', '/v1/definitions', 'bob')).json()
      expect(all).toEqual({ definitions: [{ name: 'payments', latest: two.hash }] })
      const versions = await (await api.call('GET', '/v1/definitions/payments', 'bob')).json()
      expect(versions.latest).toBe(two.hash)
      expect(versions.versions.map((v: { hash: string }) => v.hash)).toEqual([two.hash, one.hash])

      expect((await (await api.call('GET', `/v1/definitions/payments/${one.hash}`, 'bob')).json()).tasks).toEqual([
        'build',
        'test',
      ])
      expect((await (await api.call('GET', '/v1/definitions/payments/latest', 'bob')).json()).hash).toBe(two.hash)
      const content = await (await api.call('GET', `/v1/definitions/payments/${one.hash}/files`, 'bob')).json()
      expect(content).toEqual({ entry: '.hammerkit.yaml', files })
    })
  })

  it('shows nothing to who can neither run nor publish, and 404 for what is not there', async () => {
    await withApi('definitions-api-hidden', async (api) => {
      const published = await (await api.call('PUT', '/v1/definitions/payments', 'alice', bundle)).json()
      expect((await (await api.call('GET', '/v1/definitions', 'stranger')).json()).definitions ?? []).toEqual([])
      expect((await api.call('GET', '/v1/definitions/payments', 'stranger')).status).toBe(404)
      expect((await api.call('GET', `/v1/definitions/payments/${published.hash}/files`, 'stranger')).status).toBe(404)
      expect((await api.call('GET', '/v1/definitions/nothing', 'alice')).status).toBe(404)
      expect((await api.call('GET', `/v1/definitions/payments/sha256:${'1'.repeat(64)}`, 'alice')).status).toBe(404)
      expect((await api.call('GET', '/v1/definitions/payments/not-a-hash', 'alice')).status).toBe(404)
      expect((await api.call('GET', '/v1/definitions/..%2Fetc', 'alice')).status).toBe(404)
      expect((await api.call('DELETE', '/v1/definitions/payments', 'alice')).status).toBe(405)
      expect((await api.call('PUT', '/v1/definitions', 'alice', bundle)).status).toBe(405)
    })
  })

  it('refuses a bundle that is not well formed or does not load', async () => {
    await withApi('definitions-api-invalid', async (api) => {
      const put = (body: unknown) => api.call('PUT', '/v1/definitions/payments', 'alice', body)
      expect((await put({ files: { 'other.yaml': '' } })).status).toBe(400)
      expect((await put({ files: { '../x': '', '.hammerkit.yaml': '' } })).status).toBe(400)
      expect((await put({ files, extra: 1 })).status).toBe(400)
      const broken = await put({ files: { '.hammerkit.yaml': 'tasks:\n  a:\n    nope: 1\n' } })
      expect(broken.status).toBe(400)
      expect((await broken.json()).error).toContain('the build file does not load')
      expect(api.log.join('\n')).toContain('payments does not load')
      expect((await api.call('GET', '/v1/definitions/payments', 'alice')).status).toBe(404)

      const big = await put({ files: { '.hammerkit.yaml': 'x'.repeat(3 * 1024 * 1024) } })
      expect(big.status).toBe(413)
    })
  })

  it('keeps the versions over a restart', async () => {
    await withApi('definitions-api-restart', async (api) => {
      const published = await (await api.call('PUT', '/v1/definitions/payments', 'alice', bundle)).json()
      await api.restart()
      const after = await (await api.call('GET', '/v1/definitions/payments/latest', 'alice')).json()
      expect(after.hash).toBe(published.hash)
      expect(await (await api.call('GET', `/v1/definitions/payments/${published.hash}/files`, 'alice')).json()).toEqual(
        {
          entry: '.hammerkit.yaml',
          files,
        }
      )
    })
  })

  it('tells a caller what they may publish', async () => {
    await withApi('definitions-api-me', async (api) => {
      expect((await (await api.call('GET', '/v1/me', 'alice')).json()).publish).toEqual(['payments'])
      expect((await (await api.call('GET', '/v1/me', 'bob')).json()).publish).toEqual([])
    })
  })
})
