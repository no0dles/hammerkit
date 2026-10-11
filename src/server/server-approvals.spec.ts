import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'
import { readServerConfig } from './server-config'
import { RunExecutor } from './runs'
import { RunningServer, startServer } from './server'

const files = {
  '.hammerkit.yaml': `tasks:
  build:
    cmds: [echo build]
  lint:
    cmds: [echo lint]
  deploy:
    deps: [build]
    labels:
      env: production
    cmds: [echo deploy]
  release:
    deps: [deploy]
    cmds: [echo release]
`,
}

const entitlements = `
entitlements:
  - subject: { iss: ISSUER, sub: alice }
    accounts: [op-payments-dev, op-payments-prod]
    default: op-payments-dev
    publish: [payments]
  - subject: { iss: ISSUER, sub: carol }
    accounts: [op-payments-dev]
`

const approvals = (extra = '') => `
approvals:
${extra}  rules:
    - name: production
      labels: { env: production }
      approvers:
        - group: { iss: ISSUER, name: release-managers }
        - subject: { iss: ISSUER, sub: carol }
    - name: releases
      tasks: ["rel*"]
      approvers:
        - subject: { iss: ISSUER, sub: bob }
    - name: prod key
      accounts: [op-payments-prod]
      approvers:
        - group: { iss: ISSUER, name: release-managers }
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
    options?: { sub?: string | null; groups?: string[]; body?: unknown; headers?: Record<string, string> }
  ) => Promise<JsonResponse>
  run: (tasks: string[], sub?: string, extra?: { account?: string; hash?: string }) => Promise<JsonResponse>
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
        `listen: { port: 0 }\nstorage: { directory: ${JSON.stringify(
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
        const published = await call('PUT', '/v1/definitions/payments', { body: { files } })
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
                ...(extra.account ? { account: extra.account } : {}),
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

describe('approvals api', () => {
  it('runs what falls under no rule at once', async () => {
    await withApi('approvals-api-free', '', async (api) => {
      const run = await (await api.run(['build'])).json()
      expect(run.state).toBe('queued')
      expect(run.approval).toBeUndefined()
      expect((await untilState(api, run.id, ['succeeded'])).state).toBe('succeeded')
      expect(api.executed).toEqual(['build'])
      expect(api.log.join('\n')).not.toContain('approval=')
    })
  })

  it('holds a run under a rule until an approver lets it go', async () => {
    await withApi('approvals-api-approve', '', async (api) => {
      const response = await api.run(['deploy'])
      expect(response.status).toBe(202)
      const run = await response.json()
      expect(run).toMatchObject({ state: 'awaiting-approval', tasks: ['deploy'] })
      expect(run.approval.rules).toEqual([{ index: 0, name: 'production' }])
      expect(api.log.join('\n')).toContain('approval=[0]')
      await sleep(30)
      expect(api.executed).toEqual([])

      // the group of release managers sees it, with what to decide on
      const list = await (await api.call('GET', '/v1/approvals', { sub: 'dave', groups: ['release-managers'] })).json()
      expect(list.approvals).toHaveLength(1)
      expect(list.approvals[0]).toMatchObject({
        id: run.id,
        requestedBy: { sub: 'alice' },
        definition: run.definition,
        tasks: ['deploy'],
        account: 'op-payments-dev',
        source: { type: 'ref', ref: 'main' },
      })

      const approved = await api.approve(run.id, 'dave', ['release-managers'])
      expect(approved.status).toBe(200)
      expect((await approved.json()).approval.rules[0].approvedBy.sub).toBe('dave')
      const finished = await untilState(api, run.id, ['succeeded'])
      expect(finished.approval.rules[0]).toMatchObject({ name: 'production', approvedBy: { sub: 'dave' } })
      expect(api.executed).toEqual(['deploy'])
      expect(api.log.join('\n')).toMatch(new RegExp(`approve run=${run.id} iss=\\S+ sub=dave result=ok`))

      // gone from the list, and decided once
      const after = await (await api.call('GET', '/v1/approvals', { sub: 'dave', groups: ['release-managers'] })).json()
      expect(after.approvals).toEqual([])
      expect((await api.approve(run.id, 'dave', ['release-managers'])).status).toBe(409)
    })
  })

  it('counts what a task needs first, and wants every rule approved', async () => {
    await withApi('approvals-api-both', '', async (api) => {
      const run = await (await api.run(['release'])).json()
      expect(run.approval.rules.map((r: { name: string }) => r.name)).toEqual(['production', 'releases'])

      const first = await (await api.approve(run.id, 'carol')).json()
      expect(first.state).toBe('awaiting-approval')
      // carol's rule is done, so the run is bob's alone now
      expect((await api.call('GET', '/v1/approvals', { sub: 'carol' })).status).toBe(200)
      expect((await (await api.call('GET', '/v1/approvals', { sub: 'carol' })).json()).approvals).toEqual([])
      await sleep(30)
      expect(api.executed).toEqual([])

      expect((await api.approve(run.id, 'bob')).status).toBe(200)
      await untilState(api, run.id, ['succeeded'])
      expect(api.executed).toEqual(['release'])
    })
  })

  it('lets an approver reject with a reason, which the caller sees', async () => {
    await withApi('approvals-api-reject', '', async (api) => {
      const run = await (await api.run(['deploy'])).json()
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

  it('does not let a caller approve their own run, and does not show it to others', async () => {
    await withApi('approvals-api-own', '', async (api) => {
      // carol may run and approve, but not both for the same run
      const run = await (await api.run(['deploy'], 'carol')).json()
      const own = await api.approve(run.id, 'carol')
      expect(own.status).toBe(403)
      expect((await own.json()).error).toContain('somebody else')
      expect((await api.reject(run.id, 'carol')).status).toBe(403)
      expect((await (await api.call('GET', '/v1/approvals', { sub: 'carol' })).json()).approvals).toEqual([])

      // who approves nothing finds nothing, not even that it exists
      expect((await api.approve(run.id, 'mallory')).status).toBe(404)
      expect((await api.approve(run.id, 'bob')).status).toBe(404)
      expect((await api.call('GET', `/v1/approvals/${run.id}`, { sub: 'mallory' })).status).toBe(404)
      expect((await (await api.call('GET', '/v1/approvals', { sub: 'mallory' })).json()).approvals).toEqual([])
      expect((await api.call('GET', `/v1/approvals/${run.id}`, { sub: 'bob' })).status).toBe(404)
      expect(
        (await api.call('GET', `/v1/approvals/${run.id}`, { sub: 'dave', groups: ['release-managers'] })).status
      ).toBe(200)
      expect((await api.call('GET', `/v1/runs/${run.id}`, { sub: 'dave', groups: ['release-managers'] })).status).toBe(
        404
      )
      await sleep(30)
      expect(api.executed).toEqual([])
    })
  })

  it('holds the runs of an account however the build file is changed, which tasks and labels are not safe against', async () => {
    await withApi('approvals-api-account', '', async (api) => {
      // alice may publish the build file, so she can drop the label and rename the task
      const changed = {
        '.hammerkit.yaml': files['.hammerkit.yaml']
          .replace(/deploy/g, 'ship')
          .replace(/ {4}labels:\n {6}env: production\n/, ''),
      }
      expect(changed['.hammerkit.yaml']).not.toContain('production')
      const published = await api.call('PUT', '/v1/definitions/payments', { body: { files: changed } })
      expect(published.status).toBe(201)
      const hash = (await published.json()).hash

      // with the dev key the changed task runs without a second pair of eyes
      const free = await (await api.run(['ship'], 'alice', { hash })).json()
      expect(free.state).toBe('queued')
      // the production key is what the rule is about, and it is not in the build file
      const held = await (await api.run(['ship'], 'alice', { hash, account: 'op-payments-prod' })).json()
      expect(held.state).toBe('awaiting-approval')
      expect(held.approval.rules.map((r: { name: string }) => r.name)).toEqual(['prod key'])
      // even a task that is nothing special
      const build = await (await api.run(['build'], 'alice', { hash, account: 'op-payments-prod' })).json()
      expect(build.state).toBe('awaiting-approval')

      expect((await api.approve(held.id, 'alice')).status).toBe(404)
      expect((await api.approve(held.id, 'dave', ['release-managers'])).status).toBe(200)
      await untilState(api, held.id, ['succeeded'])
    })
  })

  it('lets the caller withdraw a run that waits', async () => {
    await withApi('approvals-api-withdraw', '', async (api) => {
      const run = await (await api.run(['deploy'])).json()
      const cancelled = await api.call('POST', `/v1/runs/${run.id}/cancel`)
      expect((await cancelled.json()).state).toBe('cancelled')
      expect((await api.approve(run.id, 'carol')).status).toBe(409)
    })
  })

  it('shows approvers the build files they decide on, and tells who they are', async () => {
    await withApi('approvals-api-visibility', '', async (api) => {
      const me = (sub: string) => api.call('GET', '/v1/me', { sub }).then((r) => r.json())
      expect((await me('bob')).approver).toBe(true)
      expect((await me('alice')).approver).toBe(false)
      expect((await me('mallory')).approver).toBe(false)
      expect((await api.call('GET', '/v1/definitions', { sub: 'bob' })).status).toBe(200)
      expect((await api.call('GET', '/v1/definitions/payments/latest/files', { sub: 'bob' })).status).toBe(200)
      expect((await api.call('GET', '/v1/definitions', { sub: 'mallory' })).status).toBe(404)
      // approving is not running: an approver without an account can't submit
      expect((await api.run(['build'], 'bob')).status).toBe(403)
    })
  })

  it('refuses more waiting runs than the limit', async () => {
    await withApi('approvals-api-limit', '  maxWaiting: 1\n', async (api) => {
      expect((await api.run(['deploy'])).status).toBe(202)
      const more = await api.run(['deploy'])
      expect(more.status).toBe(503)
      expect((await more.json()).error).toContain('too many runs are waiting')
      expect((await api.run(['build'])).status).toBe(202)
    })
  })

  it('rejects a run nobody approves within the timeout', async () => {
    await withApi('approvals-api-timeout', '  timeout: 1s\n', async (api) => {
      const run = await (await api.run(['deploy'])).json()
      const rejected = await untilState(api, run.id, ['rejected'])
      expect(rejected.error).toBe('nobody approved it in time')
      expect(api.executed).toEqual([])
    })
  })

  it('answers what is not an approval call', async () => {
    await withApi('approvals-api-routes', '', async (api) => {
      const run = await (await api.run(['deploy'])).json()
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
