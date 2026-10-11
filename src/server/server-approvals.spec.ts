import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'
import { readServerConfig } from './server-config'
import { HOST_ENV_ALLOW } from '../testing/host-env'
import { RunExecutor } from './runs'
import { RunningServer, startServer } from './server'

const files = {
  '.hammerkit.yaml': `tasks:
  build:
    cmds: [echo build]
  deploy:
    deps: [build]
    secrets:
      - { from: "echo:kube", account: op-payments-prod, env: KUBE_TOKEN }
    cmds: [echo deploy]
  migrate:
    secrets:
      - { from: "echo:db", account: op-payments-db, env: DB_PASSWORD }
    cmds: [echo migrate]
  release:
    deps: [deploy, migrate]
    cmds: [echo release]
`,
}

// alice and erin use the dev key themselves, or nothing, and ask for the others,
// which carol uses and the release managers (prod) and the dba (db) approve; bob
// uses dev only; carol publishes the build files, as she uses every account in them
const entitlements = `
secretProviders:
  echo: { command: [${JSON.stringify(process.execPath)}, -e, "process.stdout.write(process.argv[1])", "{{ref}}"] }
accounts:
  op-payments-dev: { providers: { echo: { env: {} } } }
  op-payments-prod: { providers: { echo: { env: {} } } }
  op-payments-db: { providers: { echo: { env: {} } } }
entitlements:
  - subject: { iss: ISSUER, sub: alice }
    accounts: { op-payments-dev: use, op-payments-prod: request, op-payments-db: request }
    builds: run
  - subject: { iss: ISSUER, sub: erin }
    accounts: { op-payments-prod: request }
    builds: run
  - subject: { iss: ISSUER, sub: carol }
    accounts: { op-payments-dev: use, op-payments-prod: use, op-payments-db: use }
    builds: publish
  - group: { iss: ISSUER, name: release-managers }
    accounts: { op-payments-prod: use }
  - subject: { iss: ISSUER, sub: dba }
    accounts: { op-payments-db: use }
  - subject: { iss: ISSUER, sub: bob }
    accounts: { op-payments-dev: use }
    builds: run
`

const approvals = (extra = '') => (extra ? `\napprovals:\n${extra}` : '')

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
    options?: { sub?: string | null; groups?: string[]; body?: unknown; headers?: Record<string, string> }
  ) => Promise<JsonResponse>
  run: (tasks: string[], sub?: string, extra?: { hash?: string }) => Promise<JsonResponse>
  approve: (id: string, sub: string, groups?: string[]) => Promise<JsonResponse>
  reject: (id: string, sub: string, reason?: string) => Promise<JsonResponse>
}

async function withApi(name: string, extra: string, fn: (api: Api) => Promise<void>) {
  const key = createTestKey('ES256', 'k1')
  const idp = await startTestIssuer([key])
  try {
    await createTestCase(name, {}).setup(async (cwd, env) => {
      const file = join(cwd, 'server.yaml')
      writeFileSync(
        file,
        `runs: { env: { allow: ${JSON.stringify(
          HOST_ENV_ALLOW
        )} } }\nlisten: { port: 0 }\nstorage: { directory: ${JSON.stringify(
          join(cwd, 'server-data')
        )} }\nissuers:\n  - { issuer: "${idp.url}", audience: hammerkit }\n${(entitlements + approvals(extra)).replace(
          /ISSUER/g,
          `"${idp.url}"`
        )}`
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
      const token = (sub: string, groups: string[] = []) =>
        signToken(key, { iss: idp.url, sub, groups, aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 300 })
      const call: Api['call'] = (method, path, options = {}) =>
        fetch(`${server.url}${path}`, {
          method,
          headers: {
            ...(options.sub === null
              ? {}
              : { authorization: `Bearer ${token(options.sub ?? 'alice', options.groups)}` }),
            ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...options.headers,
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        }) as Promise<JsonResponse>
      try {
        const published = await call('PUT', '/v1/definitions/payments', { sub: 'carol', body: { files } })
        if (published.status !== 201) {
          throw new Error(`could not publish the build file: ${published.status}`)
        }
        const hash = (await published.json()).hash
        await fn({
          server,
          log,
          executed,
          call,
          run: (tasks, sub, extra = {}) =>
            call('POST', '/v1/runs', {
              sub,
              body: {
                definition: { name: 'payments', hash: extra.hash ?? hash },
                tasks,
                source: { type: 'ref', ref: 'main' },
              },
            }),
          approve: (id, sub, groups) => call('POST', `/v1/approvals/${id}/approve`, { sub, groups }),
          reject: (id, sub, reason) =>
            call('POST', `/v1/approvals/${id}/reject`, { sub, body: reason ? { reason } : undefined }),
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

async function untilState(api: Api, id: string, states: string[], sub = 'alice') {
  for (let i = 0; i < 100; i++) {
    const run = await (await api.call('GET', `/v1/runs/${id}`, { sub })).json()
    if (states.includes(run.state)) {
      return run
    }
    await sleep(10)
  }
  throw new Error(`run ${id} never reached ${states}`)
}

const MANAGERS = ['release-managers']

describe('approvals api', () => {
  it('runs at once what needs no account, or only accounts the caller uses', async () => {
    await withApi('approvals-api-free', '', async (api) => {
      const run = await (await api.run(['build'])).json()
      expect(run.state).toBe('queued')
      expect(run.approvals).toBeUndefined()
      expect((await untilState(api, run.id, ['succeeded'])).state).toBe('succeeded')
      expect(api.executed).toEqual(['build'])
      expect(api.log.join('\n')).not.toContain('approval=')

      // carol uses the production account, nobody has to agree
      const carol = await (await api.run(['deploy'], 'carol')).json()
      expect(carol).toMatchObject({ state: 'queued', accounts: ['op-payments-prod'] })
    })
  })

  it('holds a run on a requested account until somebody who uses it lets it go', async () => {
    await withApi('approvals-api-approve', '', async (api) => {
      const response = await api.run(['deploy'], 'alice')
      expect(response.status).toBe(202)
      const run = await response.json()
      expect(run).toMatchObject({
        state: 'awaiting-approval',
        tasks: ['deploy'],
        accounts: ['op-payments-prod'],
        approvals: [{ account: 'op-payments-prod' }],
      })
      expect(api.log.join('\n')).toContain('approval=[op-payments-prod]')
      await sleep(30)
      expect(api.executed).toEqual([])

      // the release managers see it, with what to decide on
      const list = await (await api.call('GET', '/v1/approvals', { sub: 'dave', groups: MANAGERS })).json()
      expect(list.approvals).toHaveLength(1)
      expect(list.approvals[0]).toMatchObject({
        id: run.id,
        requestedBy: { sub: 'alice' },
        definition: run.definition,
        tasks: ['deploy'],
        accounts: ['op-payments-prod'],
        source: { type: 'ref', ref: 'main' },
      })

      // with what the tasks do: the commands, the secrets and the account they are read as
      expect(list.approvals[0].plan).toMatchObject({
        build: { cmds: ['echo build'], accounts: [] },
        deploy: {
          cmds: ['echo deploy'],
          deps: ['build'],
          accounts: ['op-payments-prod'],
          secrets: [{ from: 'echo:kube', account: 'op-payments-prod', target: 'KUBE_TOKEN' }],
        },
      })

      const approved = await api.approve(run.id, 'dave', MANAGERS)
      expect(approved.status).toBe(200)
      expect((await approved.json()).approvals[0].approvedBy.sub).toBe('dave')
      const finished = await untilState(api, run.id, ['succeeded'])
      expect(finished.approvals[0]).toMatchObject({ approvedBy: { sub: 'dave' } })
      expect(api.executed).toEqual(['deploy'])
      expect(api.log.join('\n')).toMatch(new RegExp(`approve run=${run.id} iss=\\S+ sub=dave result=ok`))

      // gone from the list, and decided once
      const after = await (await api.call('GET', '/v1/approvals', { sub: 'dave', groups: MANAGERS })).json()
      expect(after.approvals).toEqual([])
      expect((await api.approve(run.id, 'dave', MANAGERS)).status).toBe(409)
    })
  })

  it('lets a caller with only requests run what has no secrets, and holds the rest', async () => {
    await withApi('approvals-api-request-only', '', async (api) => {
      const free = await (await api.run(['build'], 'erin')).json()
      expect(free).toMatchObject({ state: 'queued', accounts: [] })
      const run = await (await api.run(['deploy'], 'erin')).json()
      expect(run).toMatchObject({ state: 'awaiting-approval', accounts: ['op-payments-prod'] })
      expect((await api.approve(run.id, 'carol')).status).toBe(200)
      await untilState(api, run.id, ['succeeded'], 'erin')
    })
  })

  it('releases a run of several accounts when the approvals cover all of them', async () => {
    await withApi('approvals-api-several', '', async (api) => {
      const run = await (await api.run(['release'], 'alice')).json()
      expect(run.accounts).toEqual(['op-payments-db', 'op-payments-prod'])
      expect(run.approvals.map((a: { account: string }) => a.account)).toEqual(['op-payments-db', 'op-payments-prod'])
      expect(new Set(run.approvals.map((a: { expiresAt: string }) => a.expiresAt)).size).toBe(1)

      // one account covered, the run still waits and shows what is left
      const first = await api.approve(run.id, 'dave', MANAGERS)
      expect(first.status).toBe(200)
      const waiting = await first.json()
      expect(waiting.state).toBe('awaiting-approval')
      expect(waiting.approvals.map((a: { approvedBy?: { sub: string } }) => a.approvedBy?.sub)).toEqual([
        undefined,
        'dave',
      ])
      expect((await api.approve(run.id, 'dave', MANAGERS)).status).toBe(409)
      await sleep(30)
      expect(api.executed).toEqual([])
      // somebody who uses db has it in their list, dave has nothing left to do
      expect(
        (await (await api.call('GET', '/v1/approvals', { sub: 'dave', groups: MANAGERS })).json()).approvals
      ).toEqual([])
      expect((await (await api.call('GET', '/v1/approvals', { sub: 'dba' })).json()).approvals).toHaveLength(1)

      expect((await (await api.approve(run.id, 'dba')).json()).state).toBe('queued')
      expect((await untilState(api, run.id, ['succeeded'])).state).toBe('succeeded')
    })
  })

  it('is released by one approver who uses all the accounts that wait', async () => {
    await withApi('approvals-api-one-approver', '', async (api) => {
      const run = await (await api.run(['release'], 'alice')).json()
      expect((await (await api.approve(run.id, 'carol')).json()).state).toBe('queued')
      const done = await untilState(api, run.id, ['succeeded'])
      expect(done.approvals.map((a: { approvedBy: { sub: string } }) => a.approvedBy.sub)).toEqual(['carol', 'carol'])
    })
  })

  it('ends the run when somebody who uses one of the accounts rejects it', async () => {
    await withApi('approvals-api-reject-one', '', async (api) => {
      const run = await (await api.run(['release'], 'alice')).json()
      await api.approve(run.id, 'dave', MANAGERS)
      const rejected = await api.reject(run.id, 'dba', 'db migration not ready')
      expect((await rejected.json()).state).toBe('rejected')
      expect(api.executed).toEqual([])
    })
  })

  it('lets an approver reject with a reason, which the caller sees', async () => {
    await withApi('approvals-api-reject', '', async (api) => {
      const run = await (await api.run(['deploy'], 'alice')).json()
      const rejected = await api.reject(run.id, 'carol', 'not on a friday')
      expect(rejected.status).toBe(200)
      expect((await rejected.json()).state).toBe('rejected')
      const seen = await untilState(api, run.id, ['rejected'])
      expect(seen.error).toBe('rejected by carol: not on a friday')
      const events = await (await api.call('GET', `/v1/runs/${run.id}/events`)).text()
      expect(events).toContain('event: approval')
      expect(events).toContain('"outcome":"rejected"')
      expect(events).toContain('event: state')
      expect(api.executed).toEqual([])
      expect((await api.reject(run.id, 'carol')).status).toBe(409)
    })
  })

  it('shows a run only to who uses an account it waits for', async () => {
    await withApi('approvals-api-own', '', async (api) => {
      const run = await (await api.run(['deploy'], 'alice')).json()

      // the caller asked for it, she does not decide on it
      expect((await api.approve(run.id, 'alice')).status).toBe(404)
      expect((await (await api.call('GET', '/v1/approvals', { sub: 'alice' })).json()).approvals).toEqual([])
      // using the dev key is not using the prod key; who is nothing finds nothing
      for (const sub of ['bob', 'mallory', 'dba']) {
        expect((await api.approve(run.id, sub)).status).toBe(404)
        expect((await api.reject(run.id, sub)).status).toBe(404)
        expect((await api.call('GET', `/v1/approvals/${run.id}`, { sub })).status).toBe(404)
        expect((await (await api.call('GET', '/v1/approvals', { sub })).json()).approvals).toEqual([])
      }
      expect((await api.call('GET', `/v1/approvals/${run.id}`, { sub: 'dave', groups: MANAGERS })).status).toBe(200)
      // who uses the account may follow the run, nobody else may
      expect((await api.call('GET', `/v1/runs/${run.id}`, { sub: 'dave', groups: MANAGERS })).status).toBe(200)
      for (const sub of ['bob', 'mallory', 'dba']) {
        expect((await api.call('GET', `/v1/runs/${run.id}`, { sub })).status).toBe(404)
        expect((await api.call('GET', `/v1/runs/${run.id}/events`, { sub })).status).toBe(404)
        expect((await api.call('POST', `/v1/runs/${run.id}/cancel`, { sub })).status).toBe(404)
      }
      await sleep(30)
      expect(api.executed).toEqual([])
    })
  })

  it('lets who uses the account of a run follow it and stop it', async () => {
    await withApi('approvals-api-follow', '', async (api) => {
      const run = await (await api.run(['deploy'], 'alice')).json()
      const seen = await api.call('GET', `/v1/runs/${run.id}`, { sub: 'dave', groups: MANAGERS })
      expect((await seen.json()).accounts).toEqual(['op-payments-prod'])

      const cancelled = await api.call('POST', `/v1/runs/${run.id}/cancel`, { sub: 'dave', groups: MANAGERS })
      expect(cancelled.status).toBe(200)
      expect((await cancelled.json()).state).toBe('cancelled')
      const events = await (
        await api.call('GET', `/v1/runs/${run.id}/events`, { sub: 'dave', groups: MANAGERS })
      ).text()
      expect(events).toContain('event: state')
      // the list stays the caller's own
      expect((await (await api.call('GET', '/v1/runs', { sub: 'dave', groups: MANAGERS })).json()).runs).toEqual([])
      expect(api.executed).toEqual([])
    })
  })

  it('does not let a requester use an account they only asked for, whatever the build file says', async () => {
    await withApi('approvals-api-build-file', '', async (api) => {
      // the accounts come from the secrets of the files the run is pinned to, so a
      // renamed task changes nothing: alice does not choose them, nor can she hide one
      const changed = { '.hammerkit.yaml': files['.hammerkit.yaml'].replace(/deploy/g, 'ship') }
      const published = await api.call('PUT', '/v1/definitions/payments', { sub: 'carol', body: { files: changed } })
      expect(published.status).toBe(201)
      const hash = (await published.json()).hash

      const free = await (await api.run(['build'], 'alice', { hash })).json()
      expect(free.state).toBe('queued')
      const held = await (await api.run(['ship'], 'alice', { hash })).json()
      expect(held).toMatchObject({ state: 'awaiting-approval', accounts: ['op-payments-prod'] })
      expect((await api.approve(held.id, 'alice')).status).toBe(404)
      expect((await api.approve(held.id, 'dave', MANAGERS)).status).toBe(200)
      await untilState(api, held.id, ['succeeded'])
    })
  })

  it('refuses an account the caller neither uses nor may request, naming it', async () => {
    await withApi('approvals-api-unknown', '', async (api) => {
      const response = await api.run(['deploy'], 'bob')
      expect(response.status).toBe(403)
      expect((await response.json()).error).toContain('op-payments-prod')
    })
  })

  it('lets the caller withdraw a run that waits', async () => {
    await withApi('approvals-api-withdraw', '', async (api) => {
      const run = await (await api.run(['deploy'], 'alice')).json()
      const cancelled = await api.call('POST', `/v1/runs/${run.id}/cancel`)
      expect((await cancelled.json()).state).toBe('cancelled')
      expect((await api.approve(run.id, 'carol')).status).toBe(409)
    })
  })

  it('tells who may do what, and shows the build files to those who decide on them', async () => {
    await withApi('approvals-api-visibility', '', async (api) => {
      const me = (sub: string) => api.call('GET', '/v1/me', { sub }).then((r) => r.json())
      expect(await me('alice')).toMatchObject({
        accounts: [
          { name: 'op-payments-db', level: 'request' },
          { name: 'op-payments-dev', level: 'use' },
          { name: 'op-payments-prod', level: 'request' },
        ],
        builds: 'run',
      })
      expect(await me('erin')).toMatchObject({ accounts: [{ name: 'op-payments-prod', level: 'request' }] })
      expect((await me('carol')).builds).toBe('publish')
      expect((await api.call('GET', '/v1/definitions', { sub: 'erin' })).status).toBe(200)
      expect((await api.call('GET', '/v1/definitions/payments/latest/files', { sub: 'dba' })).status).toBe(200)
      expect((await api.call('GET', '/v1/definitions', { sub: 'mallory' })).status).toBe(404)
    })
  })

  it('refuses more waiting runs than the limit', async () => {
    await withApi('approvals-api-limit', '  maxWaiting: 1\n', async (api) => {
      expect((await api.run(['deploy'], 'alice')).status).toBe(202)
      const more = await api.run(['deploy'], 'alice')
      expect(more.status).toBe(503)
      expect((await more.json()).error).toContain('too many runs are waiting')
      expect((await api.run(['build'])).status).toBe(202)
    })
  })

  it('rejects a run nobody approves within the timeout', async () => {
    await withApi('approvals-api-timeout', '  timeout: 1s\n', async (api) => {
      const run = await (await api.run(['deploy'], 'alice')).json()
      const rejected = await untilState(api, run.id, ['rejected'])
      expect(rejected.error).toBe('nobody approved it in time')
      expect(api.executed).toEqual([])
    })
  })

  it('answers what is not an approval call', async () => {
    await withApi('approvals-api-routes', '', async (api) => {
      const run = await (await api.run(['deploy'], 'alice')).json()
      const as = { sub: 'carol' }
      expect((await api.call('GET', '/v1/approvals', { sub: null })).status).toBe(401)
      expect((await api.call('POST', '/v1/approvals', as)).status).toBe(405)
      expect((await api.call('POST', `/v1/approvals/${run.id}`, as)).status).toBe(405)
      expect((await api.call('GET', `/v1/approvals/${run.id}/approve`, as)).status).toBe(405)
      expect((await api.call('GET', '/v1/approvals/nope', as)).status).toBe(404)
      expect((await api.call('POST', '/v1/approvals/nope/approve', as)).status).toBe(404)
      expect((await api.call('POST', `/v1/approvals/${run.id}/other`, as)).status).toBe(404)

      const long = await api.call('POST', `/v1/approvals/${run.id}/reject`, {
        ...as,
        body: { reason: 'x'.repeat(501) },
      })
      expect(long.status).toBe(400)
      const extra = await api.call('POST', `/v1/approvals/${run.id}/reject`, { ...as, body: { also: 1 } })
      expect(extra.status).toBe(400)
      const text = await api.call('POST', `/v1/approvals/${run.id}/reject`, {
        ...as,
        headers: { 'content-type': 'text/plain' },
      })
      expect(text.status).toBe(415)
      // still waiting after all of that
      expect((await api.call('GET', `/v1/approvals/${run.id}`, as)).status).toBe(200)
    })
  })
})
