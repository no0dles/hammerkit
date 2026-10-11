import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'
import { readServerConfig } from './server-config'
import { RunExecutor } from './runs'
import { RunningServer, startServer } from './server'

const files = { '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo build]\n' }
const changed = { '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo build]\n  deploy:\n    cmds: [echo deploy]\n' }

// the agent may propose, dev publishes and so approves, ops publishes something else
const entitlements = `
entitlements:
  - subject: { iss: ISSUER, sub: agent }
    accounts: [dev-key]
    propose: [payments]
  - subject: { iss: ISSUER, sub: dev }
    accounts: [dev-key]
    publish: [payments]
  - subject: { iss: ISSUER, sub: ops }
    publish: [other]
  - subject: { iss: ISSUER, sub: both }
    publish: [payments]
    propose: ["*"]
`

interface JsonResponse extends Response {
  json(): Promise<any>
}

interface Api {
  server: RunningServer
  log: string[]
  executed: string[]
  call: (
    method: string,
    path: string,
    options?: { sub?: string | null; body?: unknown; headers?: Record<string, string> }
  ) => Promise<JsonResponse>
  put: (sub: string, name: string, bundle: Record<string, string>) => Promise<JsonResponse>
}

async function withApi(name: string, extra: string, fn: (api: Api) => Promise<void>) {
  const key = createTestKey('ES256', 'k1')
  const idp = await startTestIssuer([key])
  try {
    await createTestCase(name, {}).setup(async (cwd, env) => {
      const file = join(cwd, 'server.yaml')
      writeFileSync(
        file,
        `listen: { port: 0 }\nstorage: { directory: ${JSON.stringify(
          join(cwd, 'server-data')
        )} }\nissuers:\n  - { issuer: "${idp.url}", audience: hammerkit }\n${entitlements.replace(
          /ISSUER/g,
          `"${idp.url}"`
        )}${extra}`
      )
      const log: string[] = []
      const executed: string[] = []
      const executor: RunExecutor = {
        execute: async (run) => {
          executed.push(run.tasks.join(','))
        },
      }
      const server = await startServer(await readServerConfig(env, file), env, {
        log: (line) => log.push(line),
        executor,
      })
      const token = (sub: string) =>
        signToken(key, { iss: idp.url, sub, aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 300 })
      const call: Api['call'] = (method, path, options = {}) =>
        fetch(`${server.url}${path}`, {
          method,
          headers: {
            ...(options.sub === null ? {} : { authorization: `Bearer ${token(options.sub ?? 'dev')}` }),
            ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...options.headers,
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        }) as Promise<JsonResponse>
      try {
        await fn({
          server,
          log,
          executed,
          call,
          put: (sub, name, bundle) => call('PUT', `/v1/definitions/${name}`, { sub, body: { files: bundle } }),
        })
      } finally {
        await server.close()
      }
    })
  } finally {
    await idp.close()
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const path = (hash: string, rest = '') => `/v1/proposals/payments/${hash}${rest}`

describe('proposals api', () => {
  it('holds a proposed version until someone who may publish approves it', async () => {
    await withApi('proposals-api-approve', '', async (api) => {
      const response = await api.put('agent', 'payments', files)
      expect(response.status).toBe(202)
      const proposal = await response.json()
      expect(proposal).toMatchObject({
        name: 'payments',
        state: 'waiting',
        proposedBy: { sub: 'agent' },
        tasks: ['build'],
        created: true,
      })
      expect(api.log.join('\n')).toContain(`propose payments ${proposal.hash}`)

      // nothing is published, so nothing can run
      expect((await api.call('GET', '/v1/definitions/payments', { sub: 'dev' })).status).toBe(404)
      const run = await api.call('POST', '/v1/runs', {
        sub: 'agent',
        body: {
          definition: { name: 'payments', hash: proposal.hash },
          tasks: ['build'],
          account: 'dev-key',
          source: { type: 'ref', ref: 'main' },
        },
      })
      expect(run.status).toBe(400)

      // dev sees what to decide on, with the files
      const list = await (await api.call('GET', '/v1/proposals')).json()
      expect(list.proposals).toHaveLength(1)
      expect(list.proposals[0]).toMatchObject({ hash: proposal.hash, base: null, mine: false, canDecide: true })
      expect(await (await api.call('GET', path(proposal.hash, '/files'))).json()).toEqual({
        entry: '.hammerkit.yaml',
        files,
      })

      const approved = await api.call('POST', path(proposal.hash, '/approve'), { body: { reason: 'looks fine' } })
      expect(approved.status).toBe(200)
      expect(await approved.json()).toMatchObject({ state: 'approved', decidedBy: { sub: 'dev' }, canDecide: false })
      expect(api.log.join('\n')).toMatch(/approve proposal=payments@sha256:\S+ iss=\S+ sub=dev result=ok/)

      // it is the latest version now, by whoever proposed it, approved by dev
      const latest = await (await api.call('GET', '/v1/definitions/payments/latest', { sub: 'agent' })).json()
      expect(latest).toMatchObject({
        hash: proposal.hash,
        publishedBy: { sub: 'agent' },
        approvedBy: { sub: 'dev' },
      })
      const started = await api.call('POST', '/v1/runs', {
        sub: 'agent',
        body: {
          definition: { name: 'payments', hash: proposal.hash },
          tasks: ['build'],
          account: 'dev-key',
          source: { type: 'ref', ref: 'main' },
        },
      })
      expect(started.status).toBe(202)
      for (let i = 0; i < 100 && api.executed.length === 0; i++) {
        await sleep(10)
      }
      expect(api.executed).toEqual(['build'])

      // decided once
      expect((await api.call('POST', path(proposal.hash, '/approve'))).status).toBe(409)
      expect((await api.put('agent', 'payments', files)).status).toBe(200)
    })
  })

  it('shows what a version would replace', async () => {
    await withApi('proposals-api-base', '', async (api) => {
      const first = await (await api.put('dev', 'payments', files)).json()
      const proposal = await (await api.put('agent', 'payments', changed)).json()
      const seen = await (await api.call('GET', path(proposal.hash))).json()
      expect(seen).toMatchObject({ base: first.hash, tasks: ['build', 'deploy'] })
      // the published version is still the old one
      expect((await (await api.call('GET', '/v1/definitions/payments/latest')).json()).hash).toBe(first.hash)
    })
  })

  it('drops a rejected version with the reason, and lets it be proposed again', async () => {
    await withApi('proposals-api-reject', '', async (api) => {
      const proposal = await (await api.put('agent', 'payments', files)).json()
      const rejected = await api.call('POST', path(proposal.hash, '/reject'), { body: { reason: 'not like this' } })
      expect(rejected.status).toBe(200)
      expect(await rejected.json()).toMatchObject({ state: 'rejected', reason: 'not like this' })
      expect((await api.call('GET', '/v1/definitions/payments/latest')).status).toBe(404)
      expect((await api.call('POST', path(proposal.hash, '/reject'))).status).toBe(409)
      expect((await api.put('agent', 'payments', files)).status).toBe(202)
    })
  })

  it('shows a proposal to who wrote it and who decides, and to nobody else', async () => {
    await withApi('proposals-api-visibility', '', async (api) => {
      const proposal = await (await api.put('agent', 'payments', files)).json()

      const own = await (await api.call('GET', '/v1/proposals', { sub: 'agent' })).json()
      expect(own.proposals).toHaveLength(1)
      expect(own.proposals[0]).toMatchObject({ mine: true, canDecide: false })
      expect((await api.call('GET', path(proposal.hash, '/files'), { sub: 'agent' })).status).toBe(200)

      // the proposer decides nothing, and neither does who may publish something else
      for (const sub of ['agent', 'ops', 'mallory']) {
        expect((await api.call('POST', path(proposal.hash, '/approve'), { sub })).status).toBe(404)
        expect((await api.call('POST', path(proposal.hash, '/reject'), { sub })).status).toBe(404)
      }
      for (const sub of ['ops', 'mallory']) {
        expect((await (await api.call('GET', '/v1/proposals', { sub })).json()).proposals).toEqual([])
        expect((await api.call('GET', path(proposal.hash), { sub })).status).toBe(404)
        expect((await api.call('GET', path(proposal.hash, '/files'), { sub })).status).toBe(404)
      }
      expect((await api.call('GET', path(proposal.hash))).status).toBe(200)
      expect((await api.call('GET', '/v1/definitions/payments/latest')).status).toBe(404)
    })
  })

  it('publishes at once for who may publish, whatever else they may propose', async () => {
    await withApi('proposals-api-direct', '', async (api) => {
      expect((await api.put('dev', 'payments', files)).status).toBe(201)
      expect((await api.put('both', 'payments', changed)).status).toBe(201)
      // proposing another name is a proposal
      const other = await api.put('both', 'newthing', files)
      expect(other.status).toBe(202)
      expect((await other.json()).proposedBy.sub).toBe('both')
      expect((await api.call('GET', '/v1/proposals', { sub: 'ops' })).status).toBe(200)
    })
  })

  it('refuses what is neither published nor proposed by the caller', async () => {
    await withApi('proposals-api-refused', '', async (api) => {
      const refused = await api.put('agent', 'other', files)
      expect(refused.status).toBe(403)
      expect((await api.put('mallory', 'payments', files)).status).toBe(403)
      expect((await api.call('GET', '/v1/proposals', { sub: 'mallory' })).status).toBe(200)
    })
  })

  it('refuses a proposal that does not load, like a publish', async () => {
    await withApi('proposals-api-broken', '', async (api) => {
      const response = await api.put('agent', 'payments', { '.hammerkit.yaml': 'tasks: [' })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toContain('does not load')
      expect((await (await api.call('GET', '/v1/proposals')).json()).proposals).toEqual([])
    })
  })

  it('answers a proposal of what is already published with the version', async () => {
    await withApi('proposals-api-published', '', async (api) => {
      const published = await (await api.put('dev', 'payments', files)).json()
      const again = await api.put('agent', 'payments', files)
      expect(again.status).toBe(200)
      expect(await again.json()).toMatchObject({ hash: published.hash, created: false })
      expect((await (await api.call('GET', '/v1/proposals')).json()).proposals).toEqual([])
    })
  })

  it('refuses more waiting versions than the limit', async () => {
    await withApi('proposals-api-limit', 'approvals:\n  maxWaiting: 1\n', async (api) => {
      expect((await api.put('agent', 'payments', files)).status).toBe(202)
      const more = await api.put('agent', 'payments', changed)
      expect(more.status).toBe(503)
      expect((await more.json()).error).toContain('too many')
    })
  })

  it('expires a proposal nobody decides on', async () => {
    await withApi('proposals-api-timeout', 'approvals:\n  timeout: 1s\n', async (api) => {
      const proposal = await (await api.put('agent', 'payments', files)).json()
      await sleep(1200)
      expect((await (await api.call('GET', path(proposal.hash))).json()).state).toBe('expired')
      expect((await api.call('POST', path(proposal.hash, '/approve'))).status).toBe(409)
      expect((await api.call('GET', '/v1/definitions/payments/latest')).status).toBe(404)
    })
  })

  it('tells what the caller may propose', async () => {
    await withApi('proposals-api-me', '', async (api) => {
      const me = await (await api.call('GET', '/v1/me', { sub: 'agent' })).json()
      expect(me).toMatchObject({ propose: ['payments'], publish: [] })
      expect((await api.call('GET', '/v1/definitions', { sub: 'agent' })).status).toBe(200)
    })
  })

  it('answers what is not a proposal call', async () => {
    await withApi('proposals-api-routes', '', async (api) => {
      const proposal = await (await api.put('agent', 'payments', files)).json()
      expect((await api.call('GET', '/v1/proposals', { sub: null })).status).toBe(401)
      expect((await api.call('POST', '/v1/proposals')).status).toBe(405)
      expect((await api.call('POST', path(proposal.hash))).status).toBe(405)
      expect((await api.call('POST', path(proposal.hash, '/files'))).status).toBe(405)
      expect((await api.call('GET', path(proposal.hash, '/approve'))).status).toBe(405)
      expect((await api.call('GET', '/v1/proposals/payments/nope')).status).toBe(404)
      expect((await api.call('GET', `/v1/proposals/not a name/${proposal.hash}`)).status).toBe(404)
      expect((await api.call('POST', path(proposal.hash, '/other'))).status).toBe(404)
      const long = await api.call('POST', path(proposal.hash, '/reject'), { body: { reason: 'x'.repeat(501) } })
      expect(long.status).toBe(400)
      const text = await api.call('POST', path(proposal.hash, '/reject'), { headers: { 'content-type': 'text/plain' } })
      expect(text.status).toBe(415)
      expect((await api.call('GET', path(proposal.hash))).status).toBe(200)
    })
  })
})
