import { join } from 'path'
import { HOST_ENV_YAML, HOST_RUNS_YAML } from '../testing/host-env'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'
import { hashBundle } from '../remote/bundle'
import { readServerConfig } from './server-config'
import { RunningServer, startServer } from './server'

const policy = `
accounts:
  op-payments-dev: {}
  op-web-dev: {}
entitlements:
  - subject: { iss: ISSUER, sub: ci }
    builds: publish
  - subject: { iss: ISSUER, sub: alice }
    accounts: { op-payments-dev: use }
    builds: publish
  - subject: { iss: ISSUER, sub: bob }
    accounts: { op-web-dev: use }
    builds: run
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
  }) => Promise<void>,
  // what the server runs on and its runs may do
  runs = HOST_RUNS_YAML
) {
  const key = createTestKey('ES256', 'k1')
  const idp = await startTestIssuer([key])
  try {
    await createTestCase(name, {}).setup(async (cwd, env) => {
      const file = join(cwd, 'server.yaml')
      writeFileSync(
        file,
        `${runs}listen: { port: 0 }\nstorage: { directory: ${JSON.stringify(
          join(cwd, 'data')
        )} }\nissuers:\n  - { issuer: "${idp.url}", audience: hammerkit }\n${policy.replace(/ISSUER/g, `"${idp.url}"`)}`
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
      expect((await api.call('POST', '/v1/definitions', null, bundle)).status).toBe(401)
      expect((await api.call('GET', '/v1/definitions', null)).status).toBe(401)
    })
  })

  it('publishes a build file and tells its version, which is the hash of its files', async () => {
    await withApi('definitions-api-publish', async (api) => {
      const response = await api.call('POST', '/v1/definitions', 'alice', bundle)
      expect(response.status).toBe(201)
      const version = await response.json()
      expect(version).toMatchObject({
        hash: hashBundle({ entry: '.hammerkit.yaml', files }),
        entry: '.hammerkit.yaml',
        tasks: ['build', 'test'],
        services: [],
        inputs: {
          build: { src: [], mounts: [], deps: [], needs: [] },
          test: { src: [], mounts: [], deps: [], needs: [] },
        },
        accounts: [],
        plan: {
          build: { kind: 'task', runtime: 'local', cmds: ['echo build'], accounts: [], flags: ['local-task'] },
          test: { kind: 'task', runtime: 'local', cmds: ['echo test'], accounts: [], flags: ['local-task'] },
        },
        created: true,
        publishedBy: { sub: 'alice' },
      })
      expect(version).not.toHaveProperty('name')
      expect(api.log.join('\n')).toContain(`publish ${version.hash}`)

      // the same files again are the same version, whoever publishes them
      const again = await api.call('POST', '/v1/definitions', 'ci', bundle)
      expect(again.status).toBe(200)
      expect(await again.json()).toMatchObject({ hash: version.hash, created: false, publishedBy: { sub: 'alice' } })
    })
  })

  it('refuses a version that reaches more than runs.network, and shows what each task reaches', async () => {
    await withApi(
      'definitions-api-network',
      async (api) => {
        const yaml = (network: string) =>
          `tasks:\n  install:\n    image: node:22\n    network: ${network}\n    cmds: [npm ci, npm test]\n`
        const refused = await api.call('POST', '/v1/definitions', 'alice', {
          files: { '.hammerkit.yaml': yaml('open') },
        })
        expect(refused.status).toBe(400)
        expect((await refused.json()).error).toBe(
          'the build file does not load: install: asks for network open, more than this server allows (runs.network: allow registry.npmjs.org)'
        )
        const published = await api.call('POST', '/v1/definitions', 'alice', {
          files: { '.hammerkit.yaml': yaml('{ allow: [registry.npmjs.org] }') },
        })
        expect(published.status).toBe(201)
        expect((await published.json()).plan.install).toMatchObject({
          cmds: ['npm ci', 'npm test'],
          command: 'npm test',
          network: { allow: ['registry.npmjs.org'] },
        })
      },
      `${HOST_ENV_YAML.replace(' } }', ' }, network: { allow: [registry.npmjs.org] } }')}runtimes: [docker]\n`
    )
  })

  it('lets only who has a builds level publish', async () => {
    await withApi('definitions-api-permission', async (api) => {
      // running something is not publishing it
      const bob = await api.call('POST', '/v1/definitions', 'bob', bundle)
      expect(bob.status).toBe(403)
      expect((await bob.json()).error).toBe('you may not publish build files, it needs builds: propose or publish')
      expect((await api.call('POST', '/v1/definitions', 'nobody', bundle)).status).toBe(403)
      expect((await api.call('POST', '/v1/definitions', 'ci', bundle)).status).toBe(201)
      expect(api.log.join('\n')).toContain('refuse publish')
    })
  })

  it('lists versions, newest first, and reads one by its hash', async () => {
    await withApi('definitions-api-read', async (api) => {
      const one = await (await api.call('POST', '/v1/definitions', 'alice', bundle)).json()
      await new Promise((resolve) => setTimeout(resolve, 5))
      const next = {
        files: { '.hammerkit.yaml': `${files['.hammerkit.yaml']}  deploy:\n    cmds: [echo deploy]\n` },
      }
      const two = await (await api.call('POST', '/v1/definitions', 'ci', next)).json()

      const all = await (await api.call('GET', '/v1/definitions', 'bob')).json()
      expect(all.definitions.map((v: { hash: string }) => v.hash)).toEqual([two.hash, one.hash])
      expect(all.definitions[0]).toEqual({
        hash: two.hash,
        entry: '.hammerkit.yaml',
        publishedAt: two.publishedAt,
        publishedBy: two.publishedBy,
        annotations: {},
        tasks: ['build', 'deploy', 'test'],
        services: [],
        accounts: [],
      })

      expect((await (await api.call('GET', `/v1/definitions/${one.hash}`, 'bob')).json()).tasks).toEqual([
        'build',
        'test',
      ])
      const content = await (await api.call('GET', `/v1/definitions/${one.hash}/files`, 'bob')).json()
      expect(content).toEqual({ entry: '.hammerkit.yaml', files })
    })
  })

  it('keeps what the publisher says about where a version comes from, outside of its hash', async () => {
    await withApi('definitions-api-annotations', async (api) => {
      const from = { path: 'web/.hammerkit.yaml', repo: 'github.com/corp/web', machine: 'ci-7', user: 'runner' }
      const published = await api.call('POST', '/v1/definitions', 'alice', { ...bundle, annotations: from })
      expect(published.status).toBe(201)
      const version = await published.json()
      expect(version).toMatchObject({ hash: hashBundle({ entry: '.hammerkit.yaml', files }), annotations: from })

      // the same files from elsewhere are the same version, as it was first published
      const again = await api.call('POST', '/v1/definitions', 'ci', { ...bundle, annotations: { machine: 'laptop' } })
      expect(await again.json()).toMatchObject({ hash: version.hash, created: false, annotations: from })

      const other = { files: { '.hammerkit.yaml': 'tasks:\n  lint:\n    cmds: [echo lint]\n' } }
      const plain = await (await api.call('POST', '/v1/definitions', 'alice', other)).json()
      expect(plain).not.toHaveProperty('annotations')

      // the list finds the versions by what they say
      const list = async (query: string) =>
        (await (await api.call('GET', `/v1/definitions${query}`, 'bob')).json()).definitions.map(
          (v: { hash: string }) => v.hash
        )
      expect(await list('?repo=github.com/corp/web')).toEqual([version.hash])
      expect(await list('?repo=github.com/corp/web&machine=ci-7')).toEqual([version.hash])
      expect(await list('?repo=github.com/corp/web&machine=laptop')).toEqual([])
      expect(await list('')).toEqual([plain.hash, version.hash])

      await api.restart()
      expect((await (await api.call('GET', `/v1/definitions/${version.hash}`, 'bob')).json()).annotations).toEqual(from)
    })
  })

  it('refuses annotations that are not short text under a plain key', async () => {
    await withApi('definitions-api-annotations-invalid', async (api) => {
      const post = (annotations: unknown) => api.call('POST', '/v1/definitions', 'alice', { ...bundle, annotations })
      for (const annotations of [
        { 'Not A Key': 'x' },
        { note: 'x'.repeat(501) },
        { note: 1 },
        { note: '' },
        Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`k${i}`, 'x'])),
        'path=x',
      ]) {
        const response = await post(annotations)
        expect(response.status).toBe(400)
        expect((await response.json()).error).toMatch(/^annotations/)
      }
      expect((await (await api.call('GET', '/v1/definitions', 'alice')).json()).definitions).toEqual([])
    })
  })

  it('shows nothing to who can neither run nor publish, and 404 for what is not there', async () => {
    await withApi('definitions-api-hidden', async (api) => {
      const published = await (await api.call('POST', '/v1/definitions', 'alice', bundle)).json()
      expect((await api.call('GET', '/v1/definitions', 'stranger')).status).toBe(404)
      expect((await api.call('GET', `/v1/definitions/${published.hash}`, 'stranger')).status).toBe(404)
      expect((await api.call('GET', `/v1/definitions/${published.hash}/files`, 'stranger')).status).toBe(404)
      expect((await api.call('GET', `/v1/definitions/sha256:${'1'.repeat(64)}`, 'alice')).status).toBe(404)
      for (const path of ['payments', 'latest', 'not-a-hash', '..%2Fetc', `payments/${published.hash}`]) {
        expect((await api.call('GET', `/v1/definitions/${path}`, 'alice')).status).toBe(404)
      }
      // a name is not taken any more
      expect((await api.call('PUT', '/v1/definitions/payments', 'alice', bundle)).status).toBe(404)
      expect((await api.call('DELETE', `/v1/definitions/${published.hash}`, 'alice')).status).toBe(405)
      expect((await api.call('PUT', '/v1/definitions', 'alice', bundle)).status).toBe(405)
    })
  })

  it('refuses a bundle that is not well formed or does not load', async () => {
    await withApi('definitions-api-invalid', async (api) => {
      const post = (body: unknown) => api.call('POST', '/v1/definitions', 'alice', body)
      expect((await post({ files: { 'other.yaml': '' } })).status).toBe(400)
      expect((await post({ files: { '../x': '', '.hammerkit.yaml': '' } })).status).toBe(400)
      expect((await post({ files, extra: 1 })).status).toBe(400)
      const broken = await post({ files: { '.hammerkit.yaml': 'tasks:\n  a:\n    nope: 1\n' } })
      expect(broken.status).toBe(400)
      expect((await broken.json()).error).toContain('the build file does not load')
      expect(api.log.join('\n')).toContain('the build file does not load')
      expect((await (await api.call('GET', '/v1/definitions', 'alice')).json()).definitions).toEqual([])

      const big = await post({ files: { '.hammerkit.yaml': 'x'.repeat(3 * 1024 * 1024) } })
      expect(big.status).toBe(413)
    })
  })

  it('keeps the versions over a restart', async () => {
    await withApi('definitions-api-restart', async (api) => {
      const published = await (await api.call('POST', '/v1/definitions', 'alice', bundle)).json()
      await api.restart()
      const after = await (await api.call('GET', `/v1/definitions/${published.hash}`, 'alice')).json()
      expect(after.hash).toBe(published.hash)
      expect(await (await api.call('GET', `/v1/definitions/${published.hash}/files`, 'alice')).json()).toEqual({
        entry: '.hammerkit.yaml',
        files,
      })
    })
  })

  it('tells a caller what they may do with the build files', async () => {
    await withApi('definitions-api-me', async (api) => {
      expect((await (await api.call('GET', '/v1/me', 'alice')).json()).builds).toBe('publish')
      expect((await (await api.call('GET', '/v1/me', 'bob')).json()).builds).toBe('run')
      expect((await (await api.call('GET', '/v1/me', 'nobody')).json()).builds).toBeNull()
    })
  })
})
