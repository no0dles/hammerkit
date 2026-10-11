import { createHash } from 'crypto'
import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'
import { readServerConfig } from './server-config'
import { RunningServer, startServer } from './server'

// carol uses an account but may not run anything, so she has nothing to upload for
const policy = `
accounts:
  op-dev: {}
entitlements:
  - subject: { iss: ISSUER, sub: alice }
    accounts: { op-dev: use }
    builds: run
  - subject: { iss: ISSUER, sub: bob }
    accounts: { op-dev: use }
    builds: run
  - subject: { iss: ISSUER, sub: carol }
    accounts: { op-dev: use }
`

interface JsonResponse extends Response {
  json(): Promise<any>
}

interface Api {
  server: RunningServer
  log: string[]
  announce: (files: unknown, sub?: string | null) => Promise<JsonResponse>
  put: (digest: string, content: string, sub?: string | null) => Promise<JsonResponse>
  call: (method: string, path: string, sub?: string | null) => Promise<JsonResponse>
}

async function withApi(name: string, fn: (api: Api) => Promise<void>) {
  const key = createTestKey('ES256', 'k1')
  const idp = await startTestIssuer([key])
  try {
    await createTestCase(name, {}).setup(async (cwd, env) => {
      const file = join(cwd, 'server.yaml')
      writeFileSync(
        file,
        `listen: { port: 0 }\nstorage: { directory: ${JSON.stringify(join(cwd, 'data'))} }\nissuers:\n  - { issuer: "${
          idp.url
        }", audience: hammerkit }\n${policy.replace(/ISSUER/g, `"${idp.url}"`)}`
      )
      const log: string[] = []
      const server = await startServer(await readServerConfig(env, file), env, { log: (line) => log.push(line) })
      const auth = (sub: string | null) =>
        sub === null
          ? {}
          : {
              authorization: `Bearer ${signToken(key, {
                iss: idp.url,
                sub,
                aud: 'hammerkit',
                exp: Math.floor(Date.now() / 1000) + 300,
              })}`,
            }
      const api: Api = {
        server,
        log,
        announce: (files, sub = 'alice') =>
          fetch(`${server.url}/v1/sources`, {
            method: 'POST',
            headers: { ...auth(sub), 'content-type': 'application/json' },
            body: JSON.stringify({ files }),
          }) as Promise<JsonResponse>,
        put: (digest, content, sub = 'alice') =>
          fetch(`${server.url}/v1/sources/blobs/${digest}`, {
            method: 'PUT',
            headers: auth(sub),
            body: content,
          }) as Promise<JsonResponse>,
        call: (method, path, sub = 'alice') =>
          fetch(`${server.url}${path}`, { method, headers: auth(sub) }) as Promise<JsonResponse>,
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

const sha = (content: string) => createHash('sha256').update(content).digest('hex')
const file = (path: string, content: string) => ({ path, sha256: sha(content), size: content.length })

describe('sources api', () => {
  it('needs a token', async () => {
    await withApi('sources-api-auth', async (api) => {
      expect((await api.announce([file('a.txt', 'one')], null)).status).toBe(401)
      expect((await api.put(sha('one'), 'one', null)).status).toBe(401)
      expect((await api.call('GET', '/v1/sources', null)).status).toBe(401)
    })
  })

  it('announces a tree, takes the missing files and then calls it complete', async () => {
    await withApi('sources-api-flow', async (api) => {
      const announced = await api.announce([file('a.txt', 'one'), file('b/c.txt', 'two')])
      expect(announced.status).toBe(201)
      const tree = await announced.json()
      expect(tree).toMatchObject({ files: 2, bytes: 6, complete: false })
      expect(tree.snapshot).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(tree.missing).toHaveLength(2)

      expect((await api.put(sha('one'), 'one')).status).toBe(201)
      expect((await api.put(sha('one'), 'one')).status).toBe(200)
      expect((await api.put(sha('two'), 'two')).status).toBe(201)

      // the colon of the name may be escaped
      for (const name of [tree.snapshot, tree.snapshot.replace(':', '%3A')]) {
        const status = await (await api.call('GET', `/v1/sources/${name}`)).json()
        expect(status).toMatchObject({ snapshot: tree.snapshot, complete: true, missing: [] })
      }
      const again = await api.announce([file('a.txt', 'one'), file('b/c.txt', 'two')])
      expect(again.status).toBe(200)
      expect((await again.json()).complete).toBe(true)
      expect(api.log.join('\n')).toContain(`source ${tree.snapshot} iss=`)
    })
  })

  it('lists what a caller keeps, and deletes it', async () => {
    await withApi('sources-api-list', async (api) => {
      const tree = await (await api.announce([file('a.txt', 'one')])).json()
      await api.put(sha('one'), 'one')
      const list = await (await api.call('GET', '/v1/sources')).json()
      expect(list).toMatchObject({ bytes: 3, snapshots: [{ snapshot: tree.snapshot, files: 1, bytes: 3 }] })
      expect(list.limit).toBeGreaterThan(0)

      expect((await api.call('DELETE', `/v1/sources/${tree.snapshot}`)).status).toBe(200)
      expect((await api.call('DELETE', `/v1/sources/${tree.snapshot}`)).status).toBe(404)
      expect((await api.call('GET', `/v1/sources/${tree.snapshot}`)).status).toBe(404)
      expect((await (await api.call('GET', '/v1/sources')).json()).bytes).toBe(0)
    })
  })

  it('keeps trees to their owner: for anybody else they do not exist', async () => {
    await withApi('sources-api-owner', async (api) => {
      const tree = await (await api.announce([file('a.txt', 'one')])).json()
      await api.put(sha('one'), 'one')
      expect((await api.call('GET', `/v1/sources/${tree.snapshot}`, 'bob')).status).toBe(404)
      expect((await api.call('DELETE', `/v1/sources/${tree.snapshot}`, 'bob')).status).toBe(404)
      // bob cannot send content of a tree he did not announce, nor learn alice has a file
      expect((await api.put(sha('one'), 'one', 'bob')).status).toBe(400)
      const theirs = await (await api.announce([file('a.txt', 'one')], 'bob')).json()
      expect(theirs.complete).toBe(false)
    })
  })

  it('refuses callers who may not run from an upload, and those without any entitlement', async () => {
    await withApi('sources-api-grant', async (api) => {
      const carol = await api.announce([file('a.txt', 'one')], 'carol')
      expect(carol.status).toBe(403)
      expect((await carol.json()).error).toContain('uploads are not allowed')
      expect((await api.put(sha('one'), 'one', 'carol')).status).toBe(403)
      expect((await api.announce([file('a.txt', 'one')], 'mallory')).status).toBe(403)
    })
  })

  it('refuses a tree that is not well formed, or holds credentials', async () => {
    await withApi('sources-api-invalid', async (api) => {
      expect((await api.announce([])).status).toBe(400)
      expect((await api.announce([file('../a.txt', 'one')])).status).toBe(400)
      expect((await api.announce([{ path: 'a.txt', sha256: 'nope', size: 1 }])).status).toBe(400)
      const denied = await api.announce([file('src/a.ts', 'x'), file('.env', 'TOKEN=1')])
      expect(denied.status).toBe(400)
      expect((await denied.json()).error).toContain('.env')
      expect((await api.call('GET', '/v1/sources/not-a-tree')).status).toBe(404)
    })
  })

  it('checks what it is sent against what was announced', async () => {
    await withApi('sources-api-content', async (api) => {
      await api.announce([file('a.txt', 'one')])
      const wrong = await api.put(sha('one'), 'uno')
      expect(wrong.status).toBe(400)
      expect((await wrong.json()).error).toContain('digest')
      expect((await api.put(sha('one'), 'one, more')).status).toBe(400)
      expect((await api.put('xyz', 'one')).status).toBe(404)
      expect((await api.call('POST', `/v1/sources/blobs/${sha('one')}`)).status).toBe(405)
    })
  })
})
