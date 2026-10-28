import { join } from 'path'
import { hostname } from 'os'
import { writeFileSync } from 'fs'
import { execFileSync } from 'child_process'
import { createServer } from 'http'
import { AddressInfo } from 'net'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { runProgram } from '../run-program'
import { createTestKey, signToken, startTestIssuer, TestDeviceFlow } from '../testing/test-issuer'
import { readServerConfig } from '../server/server-config'
import { startServer } from '../server/server'
import { COMMIT, REPO, fakeRepos } from '../testing/repos'
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
  // variables of the environment the commands run in, as a CI job sets them
  env: (vars: { [name: string]: string | undefined }) => void
  cwd: string
  // what the last command printed, also when it failed
  output: () => string
  // Ctrl-C, or the CI job being cancelled
  abort: () => void
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
      // each task prints where it runs from; an argument that is a number is the exit code it fails with,
      // and `long` prints more than the server keeps of a run's log
      const executor: RunExecutor = {
        execute: async (run, context) => {
          executed.push(run.tasks.join(','))
          for (const task of run.tasks) {
            context.emit({ type: 'task', task, state: 'running' })
            const at = run.source.type === 'ref' ? `${run.source.ref}@${run.source.commit}` : run.source.type
            context.emit({ type: 'log', task, stream: 'stdout', text: `${task} ${at} ${run.options.args ?? ''}` })
            if (run.options.args?.[0] === 'long') {
              for (let i = 1; i <= 2000; i++) {
                context.emit({ type: 'log', task, stream: 'stdout', text: `${task} line ${i} ${'x'.repeat(600)}` })
              }
            }
            const code = Number(run.options.args?.[0])
            if (code > 0) {
              context.emit({ type: 'log', task, stream: 'stderr', text: `\tfailing\u001b[2J` })
              context.emit({ type: 'task', task, state: 'failed', exitCode: code })
              throw new Error(`${task} failed`)
            }
            context.emit({ type: 'task', task, state: 'succeeded', durationMs: 1 })
          }
        },
      }
      const server = await startServer(await readServerConfig(environment, serverFile), environment, {
        executor,
        repos: fakeRepos,
      })
      try {
        let last = memoryStream()
        const run = async (...args: string[]) => {
          const out = memoryStream()
          last = out
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
        const env: Harness['env'] = (vars) => (environment.processEnvs = { ...environment.processEnvs, ...vars })
        await fn({
          run,
          as: (sub) => (who = sub),
          token,
          call,
          executed,
          url: server.url,
          env,
          cwd,
          output: () => last.read(),
          abort: () => environment.abortCtrl.abort(),
        })
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

  it('checks the build file with --dry-run and publishes nothing, also for who may only run', async () => {
    await withHarness('remote-publish-dry-run', async (h) => {
      h.as('alice')
      await h.run('remote', 'login', 'build')
      const out = await h.run('remote', 'publish', 'build', '--dry-run')
      expect(out).toMatch(/checked with the policy of build: sha256:[0-9a-f]{64} \(2 files\), nothing was published/)
      expect(out).toContain('tasks and services: build, deploy, more:lint, smoke')
      expect(out).toContain('the server accepts it, publishing it needs builds: propose or publish')
      expect((await h.call('bob', 'GET', '/v1/definitions')).body.definitions).toEqual([])

      h.as('dana')
      await h.run('remote', 'login', 'build')
      expect(await h.run('remote', 'publish', 'build', '--dry-run')).toContain(
        'publishing it would propose it, it names accounts you do not use: op-payments-prod'
      )
      h.as('bob')
      await h.run('remote', 'login', 'build')
      expect(await h.run('remote', 'publish', 'build', '--dry-run')).toContain('publishing it would publish it')
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

  it('takes the token of a CI job or an agent instead of a sign-in', async () => {
    await withHarness('remote-publish-token', async (h) => {
      h.env({ HAMMERKIT_TOKEN: h.token('bob') })
      expect(await h.run('remote', 'publish', 'build')).toContain('published to build')

      // a token command runs for the call, and wins over a fixed token
      const run = await submit(h, 'alice', 'deploy')
      h.env({
        HAMMERKIT_TOKEN: h.token('alice'),
        HAMMERKIT_TOKEN_COMMAND: `${JSON.stringify(process.execPath)} -e "process.stdout.write('${h.token('bob')}')"`,
      })
      expect(await h.run('remote', 'approvals', 'build')).toContain(run.id)
      expect(await h.run('remote', 'approve', run.id, 'build')).toContain('approved')

      h.env({ HAMMERKIT_TOKEN_COMMAND: undefined, HAMMERKIT_TOKEN: 'two words' })
      await expect(h.run('remote', 'publish', 'build')).rejects.toThrow('HAMMERKIT_TOKEN holds more than a token')
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

describe('remote run', () => {
  // the error and exit code a failed command ends with
  async function failure(promise: Promise<unknown>): Promise<{ message: string; exitCode: number }> {
    try {
      await promise
    } catch (e) {
      return { message: (e as Error).message, exitCode: (e as { exitCode: number }).exitCode }
    }
    throw new Error('the command did not fail')
  }

  const from = ['--repo', REPO, '--ref', 'main']

  it('runs the published build file of the checkout from a ref, prints its output and ends as it did', async () => {
    await withHarness('remote-run', async (h) => {
      await h.run('remote', 'login', 'build')
      await h.run('remote', 'publish', 'build')
      h.as('alice')
      await h.run('remote', 'login', 'build')
      const out = await h.run('remote', 'run', 'build', '--server', 'build', ...from)
      expect(out).toMatch(new RegExp(`^run_\\S+ on build: build from main at ${COMMIT}$`, 'm'))
      expect(out).toContain(`build main@${COMMIT}`)
      expect(out).toMatch(/^run_\S+ succeeded$/m)
      expect(h.executed).toEqual(['build'])

      // two tasks: each line says whose it is
      const both = await h.run('remote', 'run', 'build', 'more:lint', '--server', 'build', ...from)
      expect(both).toContain(`[build] build main@${COMMIT}`)
      expect(both).toContain(`[more:lint] more:lint main@${COMMIT}`)
    })
  })

  it('passes what follows -- to the task and exits with the code of the task that failed', async () => {
    await withHarness('remote-run-fails', async (h) => {
      await h.run('remote', 'login', 'build')
      await h.run('remote', 'use', 'build')
      await h.run('remote', 'publish')
      const run = h.run('remote', 'run', 'build', ...from, '--', '3', 'more')
      const failed = await failure(run)
      expect(failed.exitCode).toBe(3)
      expect(failed.message).toMatch(/^run_\S+ failed: build failed$/)
      // the output came before, control characters written out but tabs kept
      expect(h.output()).toContain(`build main@${COMMIT} 3,more\n\tfailing?[2J\n`)
      const [submitted] = (await h.call('bob', 'GET', '/v1/runs')).body.runs
      expect(submitted.options.args).toEqual(['3', 'more'])
    })
  })

  it('sends the timeout and the cap of a run along', async () => {
    await withHarness('remote-run-timeouts', async (h) => {
      await h.run('remote', 'login', 'build')
      await h.run('remote', 'use', 'build')
      await h.run('remote', 'publish')
      await h.run('remote', 'run', 'build', ...from, '--timeout', '30m', '--max-timeout', '2m')
      const [submitted] = (await h.call('bob', 'GET', '/v1/runs')).body.runs
      expect(submitted.options).toEqual({ timeout: '30m', maxTimeout: '2m' })
    })
  })

  it('waits for an approval and says who has to give it', async () => {
    await withHarness('remote-run-approval', async (h) => {
      await h.run('remote', 'login', 'build')
      await h.run('remote', 'publish', 'build')
      h.as('alice')
      await h.run('remote', 'login', 'build')
      const running = h.run('remote', 'run', 'deploy', '--server', 'build', ...from)
      let waiting: { id: string } | undefined
      for (let i = 0; i < 200 && !waiting; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        waiting = (await h.call('bob', 'GET', '/v1/approvals')).body.approvals[0]
      }
      expect(waiting).toBeDefined()
      expect((await h.call('bob', 'POST', `/v1/approvals/${waiting?.id}/approve`, {})).status).toBe(200)
      const out = await running
      expect(out).toContain(`waiting until somebody who uses op-payments-prod approves it, before `)
      expect(out).toContain(`: hammerkit remote approve ${waiting?.id}`)
      expect(out).toContain(`\ndeploy main@${COMMIT}`)
      expect(out).toMatch(/succeeded$/m)

      // rejected: the command fails with 1
      const again = h.run('remote', 'run', 'deploy', '--server', 'build', ...from)
      let next: { id: string } | undefined
      for (let i = 0; i < 200 && !next; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        next = (await h.call('bob', 'GET', '/v1/approvals')).body.approvals[0]
      }
      await h.call('bob', 'POST', `/v1/approvals/${next?.id}/reject`, { reason: 'not today' })
      const rejected = await failure(again)
      expect(rejected.exitCode).toBe(1)
      expect(rejected.message).toContain(`${next?.id} rejected`)
    })
  })

  it('cancels the run on the server when it is stopped', async () => {
    await withHarness('remote-run-cancel', async (h) => {
      await h.run('remote', 'login', 'build')
      await h.run('remote', 'publish', 'build')
      h.as('alice')
      await h.run('remote', 'login', 'build')
      const running = h.run('remote', 'run', 'deploy', '--server', 'build', ...from)
      let waiting: { id: string } | undefined
      for (let i = 0; i < 200 && !waiting; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10))
        waiting = (await h.call('bob', 'GET', '/v1/approvals')).body.approvals[0]
      }
      expect(waiting).toBeDefined()
      h.abort()
      const stopped = await failure(running)
      expect(stopped.exitCode).toBe(1)
      expect(stopped.message).toContain('the run was cancelled')
      // the cancel reached the server before the command ended
      expect((await h.call('bob', 'GET', `/v1/runs/${waiting?.id}`)).body.state).toBe('cancelled')
    })
  })

  it('shows the end of the log when the server cut it off', async () => {
    await withHarness('remote-run-truncated', async (h) => {
      await h.run('remote', 'login', 'build')
      await h.run('remote', 'use', 'build')
      await h.run('remote', 'publish')
      const out = await h.run('remote', 'run', 'build', ...from, '--', 'long')
      expect(out).toMatch(/succeeded$/m)
      const header = out.indexOf('… the server cut the log off at its limit, the last lines of build were:')
      expect(header).toBeGreaterThan(out.indexOf('build line 1 '))
      expect(out.indexOf('build line 2000 ', header)).toBeGreaterThan(header)
    })
  })

  it('takes the repository, branch and commit of the checkout, and refuses when the ref moved', async () => {
    await withHarness('remote-run-checkout', async (h) => {
      await h.run('remote', 'login', 'build')
      await h.run('remote', 'publish', 'build')
      const git = (...args: string[]) => execFileSync('git', args, { cwd: h.cwd, stdio: 'pipe' }).toString().trim()
      git('init', '-q', '-b', 'main')
      await expect(h.run('remote', 'run', 'build', '--server', 'build')).rejects.toThrow(
        'name the repository with --repo'
      )
      git('remote', 'add', 'origin', 'https://github.com/corp/payments.git')
      git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'x')
      const head = git('rev-parse', 'HEAD')
      // the server's main is at COMMIT, not at the commit checked out here
      await expect(h.run('remote', 'run', 'build', '--server', 'build')).rejects.toThrow(
        `main is at ${COMMIT} now, not at ${head}`
      )
      // a ref of its own is not pinned to the checkout
      expect(await h.run('remote', 'run', 'build', '--server', 'build', '--ref', 'main')).toContain('succeeded')
      git('checkout', '-q', '--detach')
      await expect(h.run('remote', 'run', 'build', '--server', 'build')).rejects.toThrow(
        'name the branch or tag with --ref'
      )
    })
  })

  it('says when the build file here is not published, and takes a version by its hash', async () => {
    await withHarness('remote-run-unpublished', async (h) => {
      await h.run('remote', 'login', 'build')
      await expect(h.run('remote', 'run', 'build', '--server', 'build', ...from)).rejects.toThrow(
        /the build file here is not published on build \(sha256:[0-9a-f]{64}\), publish it first/
      )
      const [hash] = /sha256:[0-9a-f]{64}/.exec(await h.run('--file', 'more.yaml', 'remote', 'publish', 'build')) ?? [
        '',
      ]
      expect(await h.run('remote', 'run', 'lint', '--server', 'build', '--build', hash, ...from)).toContain('succeeded')
      h.env({ HAMMERKIT_BUILD: 'sha256:nope' })
      await expect(h.run('remote', 'run', 'lint', '--server', 'build', ...from)).rejects.toThrow(
        'is not the hash of a published version'
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
      expect(all).toContain('from (unverified): ')
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
      await expect(h.run('remote', 'versions', 'build', '--filter', 'team=')).rejects.toThrow('matches nothing')
      await expect(h.run('remote', 'publish', 'build', '--annotation', 'Team=x')).rejects.toThrow('annotation Team')
    })
  })

  it('shows a published version whole: who published it, what its tasks do and every file', async () => {
    await withHarness('remote-versions-show', async (h) => {
      await h.run('remote', 'login', 'build')
      const out = await h.run('remote', 'publish', 'build', '--annotation', 'team=payments')
      const hash = /sha256:[0-9a-f]{64}/.exec(out)?.[0] as string
      await h.run('remote', 'yank', hash, 'build', '--reason', 'broken')
      // without the bold a terminal shows
      // eslint-disable-next-line no-control-regex
      const shown = (await h.run('remote', 'show', hash, 'build')).replace(/\u001b\[[0-9;]*m/g, '')
      expect(shown).toContain(`${hash} on build, published by bob`)
      expect(shown).toContain('yanked by bob: broken')
      expect(shown).toContain('from (unverified): ')
      expect(shown).toContain('team=payments')
      expect(shown).toContain('deploy  task')
      expect(shown).toContain('--- .hammerkit.yaml (entry)')

      await expect(h.run('remote', 'show', `sha256:${'0'.repeat(64)}`, 'build')).rejects.toThrow(
        'has no proposal or published version'
      )
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
      await expect(h.run('remote', 'show', 'nope', 'build')).rejects.toThrow('is not a run id or a version')

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
      // once approved, it shows as the published version
      expect(await h.run('remote', 'show', target, 'build')).toContain('published by agent')
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
      const shown = await h.run('remote', 'show', target, 'build')
      expect(shown).toContain('rejected by bob: use the other file')
      expect(shown).toContain('its files are not kept')
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
      await expect(h.run('remote', 'show', target, 'build')).rejects.toThrow('has no proposal or published version')
    })
  })

  it('checks the hash before it asks the server', async () => {
    await withHarness('remote-proposals-name', async (h) => {
      await h.run('remote', 'login', 'build')
      await expect(h.run('remote', 'show', 'payments', 'build')).rejects.toThrow('is not a run id or a version')
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

describe('remote verify', () => {
  // a stand-in server that answers lookups as `answer` says, to see what the command makes of it
  async function withLookups(
    name: string,
    answer: (keys: { task: string; key: string }[]) => unknown[],
    fn: (run: (...args: string[]) => Promise<{ ok: boolean; out: string; exitCode?: number }>) => Promise<void>
  ) {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => (body += chunk))
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.end(JSON.stringify({ checks: answer(JSON.parse(body).keys) }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    try {
      await createTestCase(name, {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml':
          'includes:\n  ci: ./ci.yaml\ntasks:\n  test:\n    src: [src]\n    cmds: [echo]\n  lint:\n    cmds: [echo]\n',
        'ci.yaml': 'tasks:\n  lint:\n    cmds: [echo]\n',
        'src/a.ts': 'a\n',
      }).setup(async (cwd, environment) => {
        environment.processEnvs = {
          ...environment.processEnvs,
          HAMMERKIT_CONFIG: join(cwd, 'config.yaml'),
          HAMMERKIT_CREDENTIALS: join(cwd, 'credentials.json'),
          HAMMERKIT_TOKEN: 'a-token',
        }
        const run = async (...args: string[]) => {
          const out = memoryStream()
          environment.stdout = out.stream
          try {
            await runProgram(environment, [HK, ...args], true)
            return { ok: true, out: out.read() }
          } catch (e) {
            return {
              ok: false,
              out: `${out.read()}${(e as Error).message}`,
              exitCode: (e as { exitCode: number }).exitCode,
            }
          }
        }
        await run('remote', 'add', 'build', url, '--issuer', 'https://idp.corp')
        await fn(run)
      })
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  }

  const passed = {
    task: 'test',
    status: 'succeeded',
    run: 'run_Qx3k9ZpL2mW7vN4a',
    by: { iss: 'https://idp.corp', sub: 'agent' },
    source: { type: 'ref', ref: 'main', commit: 'c'.repeat(40) },
    definition: 'sha256:' + 'a'.repeat(64),
    finishedAt: '2026-10-25T09:14:03.120Z',
    durationMs: 72000,
  }

  it('passes for what the server passed, and fails at once for a task it did not', async () => {
    await withLookups(
      'remote-verify-answers',
      (keys) => keys.map(({ task, key }) => ({ task, key, passed: { ...passed, task } })),
      async (run) => {
        const verified = await run('remote', 'verify', 'test', '--server', 'build', '--repo', REPO)
        expect(verified.ok).toBe(true)
        expect(verified.out).toContain('test: passed 2026-10-25T09:14:03.120Z in 1m12s, run_Qx3k9ZpL2mW7vN4a by agent')
        // a task without src has no key: it is never verified, whatever the server knows
        const unkeyed = await run('remote', 'verify', 'test', 'lint', '--server', 'build', '--repo', REPO)
        expect(unkeyed.ok).toBe(false)
        expect(unkeyed.exitCode).toBe(1)
        expect(unkeyed.out).toContain('lint: can not be verified')
        // the summary names a task of an include whole, not cut at its colon
        const included = await run('remote', 'verify', 'test', 'ci:lint', '--server', 'build', '--repo', REPO)
        expect(included.ok).toBe(false)
        expect(included.out).toContain('ci:lint: can not be verified')
        expect(included.out).toContain('not verified: ci:lint')
      }
    )
  })

  it('fails a task the answer leaves out, or answers for another key', async () => {
    await withLookups(
      'remote-verify-short',
      () => [],
      async (run) => {
        const missing = await run('remote', 'verify', 'test', '--server', 'build', '--repo', REPO)
        expect(missing.ok).toBe(false)
        expect(missing.out).toContain('test: no run on build passed it for these files')
      }
    )
    await withLookups(
      'remote-verify-other-key',
      (keys) => keys.map(({ task }) => ({ task, key: 'f'.repeat(64), passed: { ...passed, task } })),
      async (run) => {
        expect((await run('remote', 'verify', 'test', '--server', 'build', '--repo', REPO)).ok).toBe(false)
      }
    )
  })
})
