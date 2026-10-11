import { join } from 'path'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { runProgram } from '../run-program'
import { createTestKey, signToken, startTestIssuer, TestDeviceFlow } from '../testing/test-issuer'
import { readServerConfig } from '../server/server-config'
import { startServer } from '../server/server'
import { RunExecutor } from '../server/runs'

const HK = 'hammerkit'

const buildFile = `tasks:
  build:
    cmds: [echo build]
includes:
  more: ./more.yaml
`

interface Harness {
  run: (...args: string[]) => Promise<string>
  as: (sub: string) => void
  token: (sub: string) => string
  call: (sub: string, method: string, path: string, body?: unknown) => Promise<{ status: number; body: any }>
  executed: string[]
  url: string
}

async function withHarness(name: string, fn: (h: Harness) => Promise<void>) {
  const key = createTestKey('ES256', 'k1')
  let who = 'alice'
  const flow: TestDeviceFlow = { clientId: 'hammerkit-cli', interval: 0, token: () => '' }
  const idp = await startTestIssuer([key], flow)
  const token = (sub: string) =>
    signToken(key, { iss: idp.url, sub, aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 3600 })
  flow.token = () => token(who)
  try {
    await createTestCase(name, {
      '.hammerkit.yaml': buildFile,
      'more.yaml': 'tasks:\n  lint:\n    cmds: [echo]\n',
    }).setup(async (cwd, environment) => {
      const serverFile = join(cwd, 'server.yaml')
      writeFileSync(
        serverFile,
        [
          'listen: { port: 0 }',
          `storage: { directory: ${JSON.stringify(join(cwd, 'server-data'))} }`,
          'issuers:',
          `  - { issuer: "${idp.url}", audience: hammerkit, clientId: hammerkit-cli }`,
          'entitlements:',
          `  - subject: { iss: "${idp.url}", sub: alice }`,
          '    accounts: [op-payments-dev]',
          '    request: [op-payments-prod]',
          '    default: op-payments-dev',
          '    publish: [payments]',
          `  - subject: { iss: "${idp.url}", sub: carol }`,
          '    request: [op-payments-prod]',
          `  - subject: { iss: "${idp.url}", sub: bob }`,
          '    accounts: [op-payments-prod]',
          '',
        ].join('\n')
      )
      environment.processEnvs = {
        ...environment.processEnvs,
        HAMMERKIT_CONFIG: join(cwd, 'config.yaml'),
        HAMMERKIT_CREDENTIALS: join(cwd, 'credentials.json'),
      }
      const executed: string[] = []
      const executor: RunExecutor = {
        execute: async (run) => {
          executed.push(run.tasks.join(','))
        },
      }
      const server = await startServer(await readServerConfig(environment, serverFile), environment, { executor })
      try {
        const run = async (...args: string[]) => {
          const out = memoryStream()
          environment.stdout = out.stream
          await runProgram(environment, [HK, ...args], true)
          return out.read()
        }
        const call: Harness['call'] = async (sub, method, path, body) => {
          const response = await fetch(`${server.url}${path}`, {
            method,
            headers: {
              authorization: `Bearer ${token(sub)}`,
              ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
          })
          return { status: response.status, body: await response.json() }
        }
        await run('remote', 'add', 'build', server.url, '--issuer', idp.url)
        await fn({ run, as: (sub) => (who = sub), token, call, executed, url: server.url })
      } finally {
        await server.close()
      }
    })
  } finally {
    await idp.close()
  }
}

async function submit(h: Harness, sub: string, account: string) {
  const response = await h.call(sub, 'POST', '/v1/runs', {
    definition: { name: 'payments' },
    tasks: ['build'],
    account,
    source: { type: 'ref', ref: 'main' },
  })
  expect(response.status).toBe(202)
  return response.body as { id: string; state: string }
}

describe('remote publish', () => {
  it('publishes the build file and what it includes, and says what it is now', async () => {
    await withHarness('remote-publish', async (h) => {
      await h.run('remote', 'login', 'build')
      const first = await h.run('remote', 'publish', 'payments', 'build')
      expect(first).toMatch(/published payments to build: sha256:[0-9a-f]{64} \(2 files\)/)
      expect(first).toContain('tasks and services: build, more:lint')

      const again = await h.run('remote', 'publish', 'payments', 'build')
      expect(again).toContain('already published payments to build')
      const hash = /sha256:[0-9a-f]{64}/.exec(first)?.[0]
      expect(again).toContain(hash)

      const published = await h.call('alice', 'GET', '/v1/definitions/payments/latest')
      expect(published.body).toMatchObject({ hash, tasks: ['build', 'more:lint'] })
    })
  })

  it('uses the default server when it gets none, and another build file with --file', async () => {
    await withHarness('remote-publish-default', async (h) => {
      await h.run('remote', 'login', 'build')
      await h.run('remote', 'use', 'build')
      expect(await h.run('remote', 'publish', 'payments')).toContain('published payments to build')
      expect(await h.run('--file', 'more.yaml', 'remote', 'publish', 'payments')).toContain('tasks and services: lint')
    })
  })

  it('tells what the server refused and why', async () => {
    await withHarness('remote-publish-refused', async (h) => {
      h.as('bob')
      await h.run('remote', 'login', 'build')
      await expect(h.run('remote', 'publish', 'payments', 'build')).rejects.toThrow(
        'answered 403: you may not publish payments'
      )
    })
  })

  it('needs a sign-in, a registered server and a build file', async () => {
    await withHarness('remote-publish-errors', async (h) => {
      await expect(h.run('remote', 'publish', 'payments', 'build')).rejects.toThrow('not signed in to build')
      await expect(h.run('remote', 'publish', 'payments', 'nowhere')).rejects.toThrow(
        'server nowhere is not registered'
      )
      await expect(h.run('--file', 'missing.yaml', 'remote', 'publish', 'payments', 'build')).rejects.toThrow(
        'there is no build file'
      )
    })
  })
})

describe('remote approvals', () => {
  async function waitingRun(h: Harness) {
    await h.run('remote', 'login', 'build')
    await h.run('remote', 'publish', 'payments', 'build')
    return submit(h, 'alice', 'op-payments-prod')
  }

  it('lists what waits for the approver and lets them approve it', async () => {
    await withHarness('remote-approvals-approve', async (h) => {
      const run = await waitingRun(h)
      expect(run.state).toBe('awaiting-approval')

      h.as('bob')
      await h.run('remote', 'login', 'build')
      expect(await h.run('remote', 'accounts', 'build')).toContain('op-payments-prod')
      const listing = await h.run('remote', 'approvals', 'build')
      expect(listing).toContain('build: 1 waiting for your approval')
      expect(listing).toContain(run.id)
      expect(listing).toContain('requested by alice')
      expect(listing).toMatch(/payments sha256:/)
      expect(listing).toContain('tasks: build')
      expect(listing).toContain('account op-payments-prod, source ref main')
      expect(listing).toContain('needs the approval of an admin of op-payments-prod')

      expect(await h.run('remote', 'approve', run.id, 'build')).toContain(`approved ${run.id} on build, it is queued`)
      expect(await h.run('remote', 'approvals', 'build')).toContain('no runs wait for your approval')
      for (let i = 0; i < 100 && h.executed.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(h.executed).toEqual(['build'])
      expect((await h.call('alice', 'GET', `/v1/runs/${run.id}`)).body.approval.approvedBy.sub).toBe('bob')
    })
  })

  it('rejects with a reason the one who asked can read', async () => {
    await withHarness('remote-approvals-reject', async (h) => {
      const run = await waitingRun(h)
      h.as('bob')
      await h.run('remote', 'login', 'build')
      expect(await h.run('remote', 'reject', run.id, 'build', '--reason', 'not on a friday')).toContain(
        `rejected ${run.id} on build`
      )
      const seen = await h.call('alice', 'GET', `/v1/runs/${run.id}`)
      expect(seen.body).toMatchObject({ state: 'rejected', error: 'rejected by bob: not on a friday' })
      expect(h.executed).toEqual([])
    })
  })

  it('does not let the one who asked decide, nor anybody who is not admin of the account', async () => {
    await withHarness('remote-approvals-refused', async (h) => {
      const run = await waitingRun(h)
      // alice is not admin of the production account, so for her the run is not there to approve
      await expect(h.run('remote', 'approve', run.id, 'build')).rejects.toThrow('answered 404')
      expect(await h.run('remote', 'approvals', 'build')).toContain('no runs wait for your approval')
      expect((await h.call('alice', 'GET', `/v1/runs/${run.id}`)).body.state).toBe('awaiting-approval')
    })
  })

  it('checks the run id before it asks the server', async () => {
    await withHarness('remote-approvals-id', async (h) => {
      await h.run('remote', 'login', 'build')
      await expect(h.run('remote', 'approve', '../v1/me', 'build')).rejects.toThrow('is not a run id')
      await expect(h.run('remote', 'reject', 'nope', 'build')).rejects.toThrow('is not a run id')
    })
  })
})
