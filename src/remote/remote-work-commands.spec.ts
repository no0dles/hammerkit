import { join } from 'path'
import { hostname } from 'os'
import { writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { runProgram } from '../run-program'
import { createTestKey, signToken, startTestIssuer, TestDeviceFlow } from '../testing/test-issuer'
import { readServerConfig } from '../server/server-config'
import { startServer } from '../server/server'
import { REPO, fakeRepos } from '../testing/repos'
import { RunExecutor } from '../server/runs'
import { HOST_ENV_ALLOW } from '../testing/host-env'
import { describeApproval, describePlan } from './remote-work-commands'

const HK = 'hammerkit'

const buildFile = `tasks:
  build:
    cmds: [echo build]
  deploy:
    deps: [build]
    secrets:
      - { from: "echo:kube", account: op-payments-prod, env: KUBE_TOKEN }
    cmds: [echo deploy]
  smoke:
    deps: [deploy]
    cmds: ["echo smoke ${'x'.repeat(400)} \u202e end"]
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
  let who = 'bob'
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
          `runs: { env: { allow: ${JSON.stringify(HOST_ENV_ALLOW)} } }`,
          'runtimes: [docker, local]',
          'listen: { port: 0 }',
          `storage: { directory: ${JSON.stringify(join(cwd, 'server-data'))} }`,
          'issuers:',
          `  - { issuer: "${idp.url}", audience: hammerkit, clientId: hammerkit-cli }`,
          'secretProviders:',
          `  echo: { command: [${JSON.stringify(
            process.execPath
          )}, -e, "process.stdout.write(process.argv[1])", "{{ref}}"] }`,
          'accounts:',
          '  op-payments-dev: { providers: { echo: { env: {} } } }',
          '  op-payments-prod: { providers: { echo: { env: {} } } }',
          'sources:',
          '  - match: github.com/corp/*',
          'entitlements:',
          // alice runs: the dev account is hers, the production one she asks for
          `  - subject: { iss: "${idp.url}", sub: alice }`,
          '    accounts: { op-payments-dev: use, op-payments-prod: request }',
          '    repos: [github.com/corp/payments]',
          '    builds: run',
          `  - subject: { iss: "${idp.url}", sub: carol }`,
          '    accounts: { op-payments-prod: request }',
          '    repos: [github.com/corp/payments]',
          '    builds: run',
          // bob publishes, as he uses every account the build file names, and approves for prod
          `  - subject: { iss: "${idp.url}", sub: bob }`,
          '    accounts: { op-payments-dev: use, op-payments-prod: use }',
          '    repos: [github.com/corp/payments]',
          '    builds: publish',
          // dana may publish, but does not use the production account
          `  - subject: { iss: "${idp.url}", sub: dana }`,
          '    repos: [github.com/corp/payments]',
          '    builds: publish',
          `  - subject: { iss: "${idp.url}", sub: agent }`,
          '    repos: [github.com/corp/payments]',
          '    builds: propose',
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
      const server = await startServer(await readServerConfig(environment, serverFile), environment, {
        executor,
        repos: fakeRepos,
      })
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

// a run of the version published last
async function submit(h: Harness, sub: string, task: string, options: Record<string, unknown> = {}) {
  const [published] = (await h.call(sub, 'GET', '/v1/definitions')).body.definitions
  const response = await h.call(sub, 'POST', '/v1/runs', {
    definition: published.hash,
    tasks: [task],
    source: { type: 'ref', repo: REPO, ref: 'main' },
    options,
  })
  expect(response.status).toBe(202)
  return response.body as { id: string; state: string }
}

describe('remote publish', () => {
  it('publishes the build file and what it includes, and says what it is now', async () => {
    await withHarness('remote-publish', async (h) => {
      await h.run('remote', 'login', 'build')
      const first = await h.run('remote', 'publish', 'build')
      expect(first).toMatch(/published to build: sha256:[0-9a-f]{64} \(2 files\)/)
      expect(first).toContain('tasks and services: build, deploy, more:lint, smoke')

      const again = await h.run('remote', 'publish', 'build')
      expect(again).toContain('already published to build')
      const hash = /sha256:[0-9a-f]{64}/.exec(first)?.[0]
      expect(again).toContain(hash)

      const published = await h.call('bob', 'GET', `/v1/definitions/${hash}`)
      expect(published.body).toMatchObject({ hash, tasks: ['build', 'deploy', 'more:lint', 'smoke'] })
      // where it comes from rides along, outside of the hash
      expect(first).toMatch(/^from: path=\S*\.hammerkit\.yaml .*machine=/m)
      expect(published.body.annotations).toMatchObject({ machine: hostname() })
      expect(published.body.annotations.path).toMatch(/\.hammerkit\.yaml$/)
    })
  })

  it('uses the default server when it gets none, and another build file with --file', async () => {
    await withHarness('remote-publish-default', async (h) => {
      await h.run('remote', 'login', 'build')
      await h.run('remote', 'use', 'build')
      expect(await h.run('remote', 'publish')).toContain('published to build')
      expect(await h.run('--file', 'more.yaml', 'remote', 'publish')).toContain('tasks and services: lint')
    })
  })

  it('tells what the server refused and why', async () => {
    await withHarness('remote-publish-refused', async (h) => {
      h.as('alice')
      await h.run('remote', 'login', 'build')
      await expect(h.run('remote', 'publish', 'build')).rejects.toThrow(
        'answered 403: you may not publish build files, it needs builds: propose or publish'
      )
    })
  })

  it('proposes a build file that names an account the publisher does not use', async () => {
    await withHarness('remote-publish-account', async (h) => {
      h.as('dana')
      await h.run('remote', 'login', 'build')
      const out = await h.run('remote', 'publish', 'build')
      expect(out).toMatch(/proposed to build: sha256:[0-9a-f]{64}/)
      const listing = await h.run('remote', 'proposals', 'build')
      expect(listing).toContain('accounts: op-payments-prod, the proposer does not use op-payments-prod')
      const hash = /sha256:[0-9a-f]{64}/.exec(out)?.[0]
      expect((await h.call('bob', 'GET', `/v1/definitions/${hash}`)).status).toBe(404)

      // bob uses the account, so he approves it
      h.as('bob')
      await h.run('remote', 'login', 'build')
      expect(await h.run('remote', 'approve', `${hash}`, 'build')).toContain('it is published')

      // and pulls it back, which refuses runs of it until it is let go on
      expect(await h.run('remote', 'yank', `${hash}`, 'build', '--reason', 'leaks')).toContain(
        `yanked ${hash} on build`
      )
      expect((await h.call('bob', 'GET', `/v1/definitions/${hash}`)).body.yanked.reason).toBe('leaks')
      expect(await h.run('remote', 'unyank', `${hash}`, 'build')).toContain('let go on')
      expect((await h.call('bob', 'GET', `/v1/definitions/${hash}`)).body.yanked).toBeUndefined()
      await expect(h.run('remote', 'yank', 'payments', 'build')).rejects.toThrow('is not a version')
      await expect(h.run('remote', 'yank', `payments@${hash}`, 'build')).rejects.toThrow('is not a version')
    })
  })

  it('needs a sign-in, a registered server and a build file', async () => {
    await withHarness('remote-publish-errors', async (h) => {
      await expect(h.run('remote', 'publish', 'build')).rejects.toThrow('not signed in to build')
      await expect(h.run('remote', 'publish', 'nowhere')).rejects.toThrow('server nowhere is not registered')
      await expect(h.run('--file', 'missing.yaml', 'remote', 'publish', 'build')).rejects.toThrow(
        'there is no build file'
      )
    })
  })
})

describe('remote versions', () => {
  it('lists what was published with where it comes from, and finds it by that', async () => {
    await withHarness('remote-versions', async (h) => {
      await h.run('remote', 'login', 'build')
      expect(await h.run('remote', 'versions', 'build')).toContain('build: no published versions')
      const one = await h.run('remote', 'publish', 'build', '--annotation', 'team=payments', '--annotation', 'user=')
      const two = await h.run('--file', 'more.yaml', 'remote', 'publish', 'build', '--annotation', 'team=web')
      const hash = (out: string) => /sha256:[0-9a-f]{64}/.exec(out)?.[0] as string

      const all = await h.run('remote', 'versions', 'build')
      expect(all).toContain('build: 2 published')
      // newest first
      expect(all.indexOf(hash(two))).toBeLessThan(all.indexOf(hash(one)))
      expect(all).toContain('published by bob at ')
      expect(all).toContain('team=payments')
      expect(all).toContain('accounts: op-payments-prod')

      const payments = await h.run('remote', 'versions', 'build', '--filter', 'team=payments')
      expect(payments).toContain('build: 1 published')
      expect(payments).toContain(hash(one))
      expect(payments).not.toContain(hash(two))
      expect(payments).not.toMatch(/user=/)
      expect(await h.run('remote', 'versions', 'build', '--filter', 'team=none')).toContain(
        'no published versions match'
      )
      await expect(h.run('remote', 'versions', 'build', '--filter', 'team')).rejects.toThrow('is not a filter')
      await expect(h.run('remote', 'publish', 'build', '--annotation', 'Team=x')).rejects.toThrow('annotation Team')
    })
  })
})

describe('remote approvals', () => {
  async function waitingRun(h: Harness) {
    await h.run('remote', 'login', 'build')
    await h.run('remote', 'publish', 'build')
    return submit(h, 'alice', 'deploy')
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
      expect(listing).toMatch(/build file sha256:[0-9a-f]{64}/)
      expect(listing).toContain('tasks: deploy')
      expect(listing).toContain('accounts: op-payments-prod, source ref main')
      expect(listing).toContain('op-payments-prod: waits for somebody who uses it to approve')

      const shown = await h.run('remote', 'show', run.id, 'build')
      expect(shown).toContain('task, local  [local-task]')
      expect(shown).toContain('$ echo deploy')
      expect(shown).toContain('after: build')
      expect(shown).toContain('secret echo:kube as op-payments-prod -> KUBE_TOKEN')
      expect(shown).not.toContain('KUBE_TOKEN=')
      await expect(h.run('remote', 'show', 'nope', 'build')).rejects.toThrow('is not a run id or a proposed version')

      expect(await h.run('remote', 'approve', run.id, 'build')).toContain(`approved ${run.id} on build, it is queued`)
      expect(await h.run('remote', 'approvals', 'build')).toContain('no runs wait for your approval')
      for (let i = 0; i < 100 && h.executed.length === 0; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
      }
      expect(h.executed).toEqual(['deploy'])
      expect((await h.call('alice', 'GET', `/v1/runs/${run.id}`)).body.approvals[0].approvedBy.sub).toBe('bob')
    })
  })

  it('shows the approver the whole command, with format characters written out', async () => {
    await withHarness('remote-approvals-arguments', async (h) => {
      await h.run('remote', 'login', 'build')
      const [hash] = /sha256:[0-9a-f]{64}/.exec(await h.run('remote', 'publish', 'build')) ?? []
      // smoke waits for deploy, which reads a secret of prod, so it takes no arguments
      const refused = await h.call('alice', 'POST', '/v1/runs', {
        definition: hash,
        tasks: ['smoke'],
        source: { type: 'ref', repo: REPO, ref: 'main' },
        options: { args: ['--region', 'eu'] },
      })
      expect(refused.status).toBe(400)
      expect(refused.body.error).toContain('smoke takes no arguments on a server: deploy in its run reads')
      const run = await submit(h, 'alice', 'smoke', { cache: 'none' })
      expect(run.state).toBe('awaiting-approval')

      h.as('bob')
      await h.run('remote', 'login', 'build')
      const listing = await h.run('remote', 'approvals', 'build')
      expect(listing).toContain('source ref main, cache=none')
      const shown = await h.run('remote', 'show', run.id, 'build')
      expect(shown).toContain(`$ echo smoke ${'x'.repeat(400)} \\u{202e} end\n`)
      expect(shown).not.toContain('\u202e')
      expect(shown).toContain('$ echo deploy\n')
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

  it('does not let the one who asked decide, nor anybody who does not use the account', async () => {
    await withHarness('remote-approvals-refused', async (h) => {
      const run = await waitingRun(h)
      h.as('alice')
      await h.run('remote', 'login', 'build')
      // alice only requests the production account, so for her the run is not there to approve
      await expect(h.run('remote', 'approve', run.id, 'build')).rejects.toThrow('answered 404')
      expect(await h.run('remote', 'approvals', 'build')).toContain('no runs wait for your approval')
      expect((await h.call('alice', 'GET', `/v1/runs/${run.id}`)).body.state).toBe('awaiting-approval')
    })
  })

  it('checks the run id before it asks the server', async () => {
    await withHarness('remote-approvals-id', async (h) => {
      await h.run('remote', 'login', 'build')
      await expect(h.run('remote', 'approve', '../v1/me', 'build')).rejects.toThrow(
        'is not a run id or a proposed version'
      )
      await expect(h.run('remote', 'reject', 'nope', 'build')).rejects.toThrow('is not a run id or a proposed version')
    })
  })
})

describe('remote proposals', () => {
  async function proposal(h: Harness) {
    await h.run('remote', 'login', 'build')
    await h.run('remote', 'publish', 'build')
    h.as('agent')
    await h.run('remote', 'login', 'build')
    const out = await h.run('--file', 'more.yaml', 'remote', 'publish', 'build')
    const hash = /sha256:[0-9a-f]{64}/.exec(out)?.[0] as string
    h.as('bob')
    await h.run('remote', 'login', 'build')
    return { out, hash, target: hash }
  }

  it('proposes when the caller may only propose, and says what happens next', async () => {
    await withHarness('remote-proposals-propose', async (h) => {
      const { out, hash } = await proposal(h)
      expect(out).toMatch(/proposed to build: sha256:[0-9a-f]{64} \(1 file\)/)
      expect(out).toContain('tasks and services: lint')
      expect(out).toContain('can not run before somebody who may publish approves it')
      expect((await h.call('bob', 'GET', '/v1/definitions')).body.definitions).toHaveLength(1)
      expect((await h.call('agent', 'GET', `/v1/proposals/${hash}`)).body.state).toBe('waiting')
    })
  })

  it('lists them for the one who decides and for the one who proposed', async () => {
    await withHarness('remote-proposals-list', async (h) => {
      const { target } = await proposal(h)
      const listing = await h.run('remote', 'proposals', 'build')
      expect(listing).toContain('build: 1 proposed')
      expect(listing).toContain(target)
      expect(listing).toContain('proposed by agent, ')
      expect(listing).toContain('waits for your approval')
      expect(listing).toContain('tasks and services: lint')

      h.as('agent')
      await h.run('remote', 'login', 'build')
      const own = await h.run('remote', 'proposals', 'build')
      expect(own).toContain('proposed by you, waiting')

      h.as('carol')
      await h.run('remote', 'login', 'build')
      expect(await h.run('remote', 'proposals', 'build')).toContain('no proposed versions')
    })
  })

  it('shows a proposal whole before it is approved: what its tasks do and every file', async () => {
    await withHarness('remote-proposals-show', async (h) => {
      const { target } = await proposal(h)
      // without the bold a terminal shows
      // eslint-disable-next-line no-control-regex
      const shown = (await h.run('remote', 'show', target, 'build')).replace(/\u001b\[[0-9;]*m/g, '')
      expect(shown).toContain(`${target} on build, proposed by agent`)
      expect(shown).toContain('lint  task, local')
      expect(shown).toContain('$ echo')
      // the files themselves, not a comparison with anything published before
      expect(shown).toContain('--- more.yaml (entry)')
      expect(shown).toContain('  tasks:')
      expect(shown).not.toContain('.hammerkit.yaml')
    })
  })

  it('approves a proposal, which publishes it', async () => {
    await withHarness('remote-proposals-approve', async (h) => {
      const { target, hash } = await proposal(h)
      expect(await h.run('remote', 'approve', target, 'build')).toContain(
        `approved ${target} on build, it is published`
      )
      const published = await h.call('bob', 'GET', `/v1/definitions/${hash}`)
      expect(published.body).toMatchObject({ hash, publishedBy: { sub: 'agent' }, approvedBy: { sub: 'bob' } })
      expect(await h.run('remote', 'proposals', 'build')).not.toContain('waits for your approval')
      await expect(h.run('remote', 'approve', target, 'build')).rejects.toThrow('answered 409')
    })
  })

  it('rejects with a reason the one who proposed can read', async () => {
    await withHarness('remote-proposals-reject', async (h) => {
      const { target } = await proposal(h)
      expect(await h.run('remote', 'reject', target, 'build', '--reason', 'use the other file')).toContain(
        `rejected ${target} on build`
      )
      h.as('agent')
      await h.run('remote', 'login', 'build')
      expect(await h.run('remote', 'proposals', 'build')).toContain('rejected: use the other file')
    })
  })

  it('does not let the proposer, nor anybody else, decide', async () => {
    await withHarness('remote-proposals-refused', async (h) => {
      const { target } = await proposal(h)
      for (const sub of ['agent', 'carol']) {
        h.as(sub)
        await h.run('remote', 'login', 'build')
        await expect(h.run('remote', 'approve', target, 'build')).rejects.toThrow('answered 404')
      }
      // the files are for who decides and who wrote them
      await expect(h.run('remote', 'show', target, 'build')).rejects.toThrow('answered 404')
    })
  })

  it('checks the hash before it asks the server', async () => {
    await withHarness('remote-proposals-name', async (h) => {
      await h.run('remote', 'login', 'build')
      await expect(h.run('remote', 'show', 'payments', 'build')).rejects.toThrow('is not a run id or a proposed')
      await expect(h.run('remote', 'approve', '../x@sha256:00', 'build')).rejects.toThrow(
        'is not a run id or a proposed'
      )
      await expect(h.run('remote', 'approve', `payments@sha256:${'0'.repeat(64)}`, 'build')).rejects.toThrow(
        'is not a run id or a proposed'
      )
    })
  })
})

// the escapes of colors, which a terminal shows and a test does not
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')

describe('describePlan', () => {
  it('shows a version stored before plans had a command and a network', () => {
    const entry = { deps: [], needs: [], accounts: [], secrets: [], mounts: [], ports: [], generates: [], flags: [] }
    expect(
      describePlan({
        old: { ...entry, kind: 'task', runtime: 'docker', image: 'node:22', cmds: ['npm test'] },
        limited: {
          ...entry,
          kind: 'task',
          runtime: 'docker',
          cmds: ['npm ci'],
          network: { allow: ['registry.npmjs.org'] },
        },
        open: { ...entry, kind: 'service', runtime: 'docker', cmds: [], network: 'open' },
      }).map((line) => line.replace(ANSI, ''))
    ).toEqual([
      '  old  task, docker node:22',
      '    $ npm test',
      '  limited  task, docker',
      '    $ npm ci',
      '    network: {"allow":["registry.npmjs.org"]}',
      '  open  service, docker',
    ])
  })
})

describe('describeApproval', () => {
  it('shows every argument whole, each a JSON string, with format characters written out', () => {
    const long = `eu ${'y'.repeat(400)}`
    const lines = describeApproval({
      id: 'run_AAAAAAAAAAAAAAAA',
      requestedBy: { iss: 'https://idp', sub: 'alice' },
      createdAt: '2026-10-13T00:00:00Z',
      definition: 'sha256:abc',
      tasks: ['smoke'],
      accounts: [],
      source: { type: 'ref', ref: 'main' },
      options: { args: ['--region', long, 'a\u202eb', 'say "hi", twice'], cache: 'none' },
      state: 'awaiting-approval',
    }).map((line) => line.replace(ANSI, ''))
    expect(lines).toContain('  accounts: none, source ref main, cache=none')
    expect(lines).toContain(`  arguments: "--region" "${long}" "a\\u{202e}b" "say \\"hi\\", twice"`)
    expect(lines.join('\n')).not.toContain('\u202e')
  })
})
