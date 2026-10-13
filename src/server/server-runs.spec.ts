import { createHash } from 'crypto'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'
import { readServerConfig } from './server-config'
import { HOST_ENV_ALLOW } from '../testing/host-env'
import { COMMIT, REPO, SOURCES_YAML, fakeRepos } from '../testing/repos'
import { TEST_WORKER } from '../testing/worker'
import { RepoAccessOptions } from './repo-access'
import { Environment } from '../executer/environment'
import { RunExecutor, RunRegistry } from './runs'
import { RunningServer, startServer } from './server'

// alice requests runs on prod, which bob approves; bob publishes the build files,
// carol only runs what needs no credentials of prod
const policy = `
runs: { env: { allow: ${JSON.stringify(HOST_ENV_ALLOW)} }, RUNS }
runtimes: [docker, local]
secretProviders:
  echo: { command: [${JSON.stringify(process.execPath)}, -e, "process.stdout.write(process.argv[1])", "{{ref}}"] }
accounts:
  op-payments-dev: { providers: { echo: { env: {} } } }
  op-payments-ci: { providers: { echo: { env: {} } } }
  op-payments-prod: { providers: { echo: { env: {} } }, source: [ref], refs: [main, "release/*"] }
entitlements:
  - subject: { iss: ISSUER, sub: alice }
    accounts: { op-payments-dev: use, op-payments-ci: use, op-payments-prod: request }
    repos: [github.com/corp/*]
    builds: run
  - subject: { iss: ISSUER, sub: bob }
    accounts: { op-payments-dev: use, op-payments-ci: use, op-payments-prod: use }
    repos: [github.com/corp/*, gitlab.corp.com/**]
    builds: publish
  - subject: { iss: ISSUER, sub: carol }
    accounts: { op-payments-ci: use }
    repos: [github.com/corp/*]
    builds: run
  - subject: { iss: ISSUER, sub: dave }
    accounts: { op-payments-dev: use }
    repos: [github.com/corp/*]
    builds: run
`

// the responses of this api are json
interface JsonResponse extends Response {
  json(): Promise<any>
}

interface Api {
  server: RunningServer
  // the config the server was started with, to read it again
  env: Environment
  file: string
  // stops the server and starts it again on the same storage
  restart: (executor?: RunExecutor) => Promise<void>
  log: string[]
  token: (sub?: string) => string
  call: (
    method: string,
    path: string,
    options?: { sub?: string | null; body?: unknown; headers?: Record<string, string> }
  ) => Promise<JsonResponse>
  submit: (body: unknown, sub?: string) => Promise<JsonResponse>
}

async function withApi(
  name: string,
  executor: RunExecutor | undefined,
  fn: (api: Api) => Promise<void>,
  extraConfig = '',
  repos: RepoAccessOptions = fakeRepos,
  // more keys of `runs`, as the inside of a yaml flow mapping
  runs = ''
) {
  const key = createTestKey('ES256', 'k1')
  const idp = await startTestIssuer([key])
  try {
    await createTestCase(name, {}).setup(async (cwd, env) => {
      const file = join(cwd, 'server.yaml')
      writeFileSync(
        file,
        `listen: { port: 0 }\nstorage: { directory: ${JSON.stringify(
          join(cwd, 'server-data')
        )} }\nissuers:\n  - { issuer: "${idp.url}", audience: hammerkit }\n${policy
          .replace(/ISSUER/g, `"${idp.url}"`)
          .replace('RUNS', runs)}${SOURCES_YAML}${extraConfig}`
      )
      const log: string[] = []
      // the tools a run needs to find, git and the shell, come from the environment of the server
      const serverEnv = { ...env, processEnvs: { ...process.env } }
      const start = async (executor: RunExecutor | undefined) =>
        startServer(await readServerConfig(serverEnv, file), serverEnv, {
          log: (line) => log.push(line),
          executor,
          repos,
          worker: TEST_WORKER,
        })
      let server = await start(executor)
      const token = (sub = 'alice') =>
        signToken(key, { iss: idp.url, sub, aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 300 })
      // the url changes with the port of a new start
      const call: Api['call'] = (method, path, options = {}) =>
        fetch(`${server.url}${path}`, {
          method,
          headers: {
            ...(options.sub === null ? {} : { authorization: `Bearer ${token(options.sub)}` }),
            ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}),
            ...options.headers,
          },
          body: options.body === undefined ? undefined : JSON.stringify(options.body),
        }) as Promise<JsonResponse>
      const submit = (body: unknown, sub?: string) => call('POST', '/v1/runs', { body, sub })
      try {
        const published = await call('PUT', '/v1/definitions/payments', { body: bundle, sub: 'bob' })
        if (published.status !== 201) {
          throw new Error(
            `could not publish the build file: ${published.status} ${JSON.stringify(await published.json())}`
          )
        }
        request.definition.hash = (await published.json()).hash
        await fn({
          get server() {
            return server
          },
          env: serverEnv,
          file,
          restart: async (next) => {
            await server.close()
            server = await start(next)
          },
          log,
          token,
          call,
          submit,
        })
      } finally {
        await server.close()
      }
    })
  } finally {
    await idp.close()
  }
}

const bundle = {
  files: {
    '.hammerkit.yaml': [
      'tasks:',
      '  build:',
      '    cmds: [echo build]',
      '  test:',
      '    cmds: [echo test]',
      '  integration:',
      '    labels: { group: slow }',
      '    deps: [ci-secret]',
      '    cmds: [echo integration]',
      '  ci-secret:',
      '    secrets:',
      '      - { from: "echo:ci", account: op-payments-ci, env: TOKEN }',
      '    cmds: [echo ci]',
      '  deploy:',
      '    deps: [build]',
      '    secrets:',
      '      - { from: "echo:prod", account: op-payments-prod, env: KUBE_TOKEN }',
      '    cmds: [echo deploy]',
      'services:',
      '  db:',
      '    image: postgres:16',
      '',
    ].join('\n'),
  },
}
// the hash is filled in once the build file is published
const request = {
  definition: { name: 'payments', hash: 'latest' },
  tasks: ['build'],
  source: { type: 'ref', repo: REPO, ref: 'main' },
}
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function untilState(api: Api, id: string, states: string[], sub?: string) {
  // a run from a git ref fetches a checkout and starts a shell, which takes seconds on Windows
  const until = Date.now() + 30_000
  while (Date.now() < until) {
    const run = await (await api.call('GET', `/v1/runs/${id}`, { sub })).json()
    if (states.includes(run.state)) {
      return run
    }
    await sleep(10)
  }
  throw new Error(`run ${id} never reached ${states}`)
}

// a run that logs, then waits until the test lets it go or it is cancelled
function gated() {
  let release = () => undefined as void
  const executor: RunExecutor = {
    execute: (run, { emit, signal }) =>
      new Promise<void>((resolve, reject) => {
        emit({ type: 'task', task: run.tasks[0], state: 'running' })
        emit({ type: 'log', task: run.tasks[0], stream: 'stdout', text: 'compiling' })
        release = resolve
        signal.addEventListener('abort', () => reject(new Error('aborted')))
      }),
  }
  return { executor, release: () => release() }
}

const done: RunExecutor = {
  execute: async (run, { emit }) => {
    emit({ type: 'task', task: run.tasks[0], state: 'succeeded' })
  },
}

async function readEvents(response: Response): Promise<{ id: string; event: string; data: any }[]> {
  const text = await response.text()
  return text
    .split('\n\n')
    .filter((block) => block.includes('data: '))
    .map((block) => {
      const field = (name: string) => new RegExp(`^${name}: (.*)$`, 'm').exec(block)?.[1] ?? ''
      return { id: field('id'), event: field('event'), data: JSON.parse(field('data')) }
    })
}

describe('runs api', () => {
  it('needs a token like every other call', async () => {
    await withApi('runs-api-auth', done, async (api) => {
      expect((await api.call('POST', '/v1/runs', { sub: null, body: request })).status).toBe(401)
      expect((await api.call('GET', '/v1/runs', { sub: null })).status).toBe(401)
    })
  })

  it('accepts a run that needs no account, executes it and shows its state', async () => {
    await withApi('runs-api-submit', done, async (api) => {
      const response = await api.submit(request)
      expect(response.status).toBe(202)
      const run = await response.json()
      expect(run).toMatchObject({
        definition: { name: 'payments', hash: expect.stringMatching(/^sha256:/) },
        state: 'queued',
        tasks: ['build'],
        accounts: [],
        source: request.source,
      })
      expect(run.approvals).toBeUndefined()
      expect(run.owner).toBeUndefined()
      expect(run.id).toMatch(/^run_/)

      const finished = await untilState(api, run.id, ['succeeded', 'failed'])
      expect(finished.state).toBe('succeeded')
      expect(api.log.join('\n')).toMatch(
        new RegExp(`run ${run.id} iss=\\S+ sub=alice accounts=\\[\\] source=ref tasks=1`)
      )
      const list = await (await api.call('GET', '/v1/runs')).json()
      expect(list.runs.map((r: { id: string }) => r.id)).toEqual([run.id])
    })
  })

  it('derives the accounts of a run from the secrets of what it executes', async () => {
    await withApi('runs-api-accounts', done, async (api) => {
      const ci = await api.submit({ ...request, tasks: ['ci-secret'] })
      expect(ci.status).toBe(202)
      expect(await ci.json()).toMatchObject({ accounts: ['op-payments-ci'], state: 'queued' })

      // the dependencies and the tasks a label selects count, not only the ones named
      const labelled = await api.submit({
        definition: request.definition,
        source: request.source,
        options: { filter: ['group=slow'] },
      })
      expect((await labelled.json()).accounts).toEqual(['op-payments-ci'])
      const nothing = await api.submit({ ...request, tasks: ['build', 'test'] })
      expect((await nothing.json()).accounts).toEqual([])
    })
  })

  it('holds a run on an account the caller can only request, and shows who may approve', async () => {
    await withApi('runs-api-request', done, async (api) => {
      const response = await api.submit({ ...request, tasks: ['deploy'] })
      expect(response.status).toBe(202)
      const run = await response.json()
      expect(run).toMatchObject({
        state: 'awaiting-approval',
        accounts: ['op-payments-prod'],
        approvals: [{ account: 'op-payments-prod', expiresAt: expect.any(String) }],
      })
      expect(api.log.join('\n')).toContain('accounts=[op-payments-prod] source=ref tasks=1 approval=[op-payments-prod]')
      // bob uses prod and approves; the account is read from the files, not from the request
      expect((await api.call('POST', `/v1/approvals/${run.id}/approve`, { sub: 'bob' })).status).toBe(200)
      expect((await untilState(api, run.id, ['succeeded', 'failed'])).state).toBe('succeeded')
    })
  })

  it('refuses an account the caller has no level on, naming it', async () => {
    await withApi('runs-api-no-level', done, async (api) => {
      const refused = await api.submit({ ...request, tasks: ['deploy'] }, 'carol')
      expect(refused.status).toBe(403)
      expect((await refused.json()).error).toContain('you may not use the account op-payments-prod')
      expect(api.log.join('\n')).toContain('refuse run')
      // what needs no account still runs for her
      expect((await api.submit({ ...request, tasks: ['build'] }, 'carol')).status).toBe(202)

      // a caller without any entitlement may not run at all
      const none = await api.submit(request, 'mallory')
      expect(none.status).toBe(403)
      expect((await none.json()).error).toContain('not entitled')
    })
  })

  it('refuses a run of an account from a ref it does not allow', async () => {
    await withApi('runs-api-refs', done, async (api) => {
      const feature = await api.submit(
        { ...request, tasks: ['deploy'], source: { type: 'ref', repo: REPO, ref: 'feature' } },
        'bob'
      )
      expect(feature.status).toBe(403)
      expect((await feature.json()).error).toContain('only used by runs from main, release/*')
      const release = await api.submit(
        { ...request, tasks: ['deploy'], source: { type: 'ref', repo: REPO, ref: 'release/1.2' } },
        'bob'
      )
      expect(release.status).toBe(202)
      // a commit names no branch
      const commit = await api.submit(
        { ...request, tasks: ['deploy'], source: { type: 'ref', repo: REPO, ref: 'a'.repeat(40) } },
        'bob'
      )
      expect(commit.status).toBe(403)
    })
  })

  it('does not take an account in the request', async () => {
    await withApi('runs-api-no-account-field', done, async (api) => {
      expect((await api.submit({ ...request, account: 'op-payments-dev' })).status).toBe(400)
    })
  })

  it('does not run from an upload yet, and says so at once', async () => {
    await withApi('runs-api-source', done, async (api) => {
      const content = 'hello'
      const sha256 = createHash('sha256').update(content).digest('hex')
      const tree = await (
        await api.call('POST', '/v1/sources', { body: { files: [{ path: 'a.txt', sha256, size: content.length }] } })
      ).json()
      const upload = { ...request, source: { type: 'upload', snapshot: tree.snapshot } }
      // a tree that is not complete cannot be run
      const incomplete = await api.submit(upload, 'alice')
      expect(incomplete.status).toBe(400)
      expect((await incomplete.json()).error).toContain('not complete')
      await fetch(`${api.server.url}/v1/sources/blobs/${sha256}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${api.token('alice')}` },
        body: content,
      })
      const complete = await api.submit(upload, 'alice')
      expect(complete.status).toBe(501)
      expect((await complete.json()).error).toContain('upload')
      const unknown = await api.submit({ ...request, source: { type: 'upload', snapshot: `sha256:${'0'.repeat(64)}` } })
      expect(unknown.status).toBe(400)
      expect((await unknown.json()).error).toContain('not known')
    })
  })

  it('rejects a request that is not well formed', async () => {
    await withApi('runs-api-invalid', done, async (api) => {
      const post = (body: unknown, headers?: Record<string, string>) => api.call('POST', '/v1/runs', { body, headers })
      expect((await post({ ...request, tasks: [] })).status).toBe(400)
      expect((await post({ ...request, extra: 1 })).status).toBe(400)
      expect((await post({ tasks: ['build'], source: request.source })).status).toBe(400)
      expect((await post({ ...request, source: { type: 'path', path: '/etc' } })).status).toBe(400)
      expect((await post({ ...request, tasks: [''] })).status).toBe(400)

      const text = await api.call('POST', '/v1/runs', { headers: { 'content-type': 'text/plain' } })
      expect(text.status).toBe(415)
      const broken = await fetch(`${api.server.url}/v1/runs`, {
        method: 'POST',
        headers: { authorization: `Bearer ${api.token()}`, 'content-type': 'application/json' },
        body: '{ nope',
      })
      expect(broken.status).toBe(400)
      expect(((await broken.json()) as { error: string }).error).toBe('the body is not valid JSON')

      const big = await post({ ...request, tasks: ['x'.repeat(200)].concat(Array(500).fill('y'.repeat(200))) })
      expect(big.status).toBe(413)
    })
  })

  it('pins the version of the build file a run uses', async () => {
    await withApi('runs-api-definition', done, async (api) => {
      const latest = await api.submit({ ...request, definition: { name: 'payments' } })
      const run = await latest.json()
      expect(run.definition).toEqual({ name: 'payments', hash: request.definition.hash })

      // a hash that was never published, a name that doesn't exist, a task the build file doesn't have
      const missing = await api.submit({
        ...request,
        definition: { name: 'payments', hash: `sha256:${'0'.repeat(64)}` },
      })
      expect(missing.status).toBe(400)
      expect((await missing.json()).error).toContain('there is no build file payments')
      expect((await api.submit({ ...request, definition: { name: 'web' } })).status).toBe(400)
      const unknown = await api.submit({ ...request, tasks: ['build', 'nope', 'rm-rf'] })
      expect(unknown.status).toBe(400)
      expect((await unknown.json()).error).toBe('payments has no task "nope", "rm-rf"')
      expect((await api.submit({ ...request, definition: { name: 'payments', hash: 'v2' } })).status).toBe(400)
    })
  })

  it('takes the settings of a run and keeps them with it', async () => {
    await withApi('runs-api-options', done, async (api) => {
      const options = {
        env: 'staging',
        filter: ['group=unit'],
        exclude: ['slow'],
        cache: 'none',
        cacheReadOnly: true,
        timeout: '1h30m',
        skipDeps: false,
      }
      const response = await api.submit({ ...request, options })
      expect(response.status).toBe(202)
      expect((await response.json()).options).toEqual(options)
      // without any, the run has none and the server decides
      expect((await (await api.submit(request)).json()).options).toEqual({})
      // labels can select the tasks instead of names
      expect(
        (
          await api.submit({
            definition: request.definition,
            source: request.source,
            options: { filter: ['group=unit'] },
          })
        ).status
      ).toBe(202)
    })
  })

  it('passes arguments to the one task a run names, and to no task that reads secrets', async () => {
    await withApi('runs-api-args', done, async (api) => {
      const args = ['src/login.spec.ts', '-t', 'a; rm -rf /']
      const response = await api.submit({ ...request, tasks: ['deploy'], options: { args: ['--dry-run'] } })
      expect(response.status).toBe(400)
      expect((await response.json()).error).toBe(
        'deploy reads the secret KUBE_TOKEN, it takes no arguments on a server: an argument could make it print them'
      )
      expect(api.log.some((line) => line.includes('refuse run') && line.includes('deploy reads the secret'))).toBe(true)

      // a dependency that reads secrets is fine, it does not get them
      const integration = await api.submit({ ...request, tasks: ['integration'], options: { args } })
      expect(integration.status).toBe(202)
      const run = await integration.json()
      expect(run.options.args).toEqual(args)
      // the approver and the caller see the command as it runs
      expect(run.plan.integration.command).toBe(`echo integration 'src/login.spec.ts' '-t' 'a; rm -rf /'`)
      expect(run.plan['ci-secret'].command).toBe('echo ci')

      const refuse = async (body: unknown, message: string | RegExp) => {
        const refused = await api.submit(body)
        expect(refused.status).toBe(400)
        expect((await refused.json()).error).toMatch(message)
      }
      await refuse({ ...request, tasks: ['build', 'test'], options: { args } }, /arguments go to one task/)
      await refuse({ ...request, tasks: ['db'], options: { args } }, 'db is a service, arguments go to a task')
      await refuse(
        { definition: request.definition, source: request.source, options: { filter: ['group=slow'], args } },
        /arguments go to one task/
      )
      await refuse({ ...request, options: { args: Array(101).fill('x') } }, /options.args/)
      await refuse({ ...request, options: { args: ['x'.repeat(16 * 1024 + 1)] } }, /longer than 16 KiB together/)
      await refuse({ ...request, options: { args: ['a\0b'] } }, /NUL character/)
      await refuse({ ...request, options: { args: [1] } }, /options.args/)
      // no arguments are no arguments
      expect((await api.submit({ ...request, tasks: ['build', 'test'], options: { args: [] } })).status).toBe(202)
    })
  })

  it('rejects settings that are not for a server or not safe', async () => {
    await withApi('runs-api-bad-options', done, async (api) => {
      for (const options of [
        { file: 'ci/hammerkit.yaml' },
        { cache: 'forever' },
        { timeout: 'soon' },
        { watch: true },
        { concurrency: 64 },
        { filter: 'unit' },
      ]) {
        const response = await api.submit({ ...request, options })
        expect([JSON.stringify(options), response.status]).toEqual([JSON.stringify(options), 400])
      }
      // neither a task nor a label to select them
      expect((await api.submit({ definition: request.definition, source: request.source })).status).toBe(400)
    })
  })

  it('shows a run to its owner only', async () => {
    await withApi('runs-api-owner', gated().executor, async (api) => {
      const run = await (await api.submit(request)).json()
      for (const path of [`/v1/runs/${run.id}`, `/v1/runs/${run.id}/events`]) {
        expect((await api.call('GET', path, { sub: 'bob' })).status).toBe(404)
      }
      expect((await api.call('POST', `/v1/runs/${run.id}/cancel`, { sub: 'bob' })).status).toBe(404)
      expect((await (await api.call('GET', '/v1/runs', { sub: 'bob' })).json()).runs).toEqual([])
      expect((await api.call('GET', `/v1/runs/${run.id}`)).status).toBe(200)
    })
  })

  it('cancels a running run', async () => {
    await withApi('runs-api-cancel', gated().executor, async (api) => {
      const run = await (await api.submit(request)).json()
      await untilState(api, run.id, ['running'])
      const cancelled = await api.call('POST', `/v1/runs/${run.id}/cancel`)
      expect(cancelled.status).toBe(200)
      expect((await untilState(api, run.id, ['cancelled'])).state).toBe('cancelled')
    })
  })

  it('streams the events of a finished run, and only those after the last one seen', async () => {
    await withApi('runs-api-events', done, async (api) => {
      const run = await (await api.submit(request)).json()
      await untilState(api, run.id, ['succeeded'])

      const all = await readEvents(await api.call('GET', `/v1/runs/${run.id}/events`))
      expect(all.map((e) => [e.id, e.event])).toEqual([
        ['1', 'state'],
        ['2', 'state'],
        ['3', 'task'],
        ['4', 'state'],
      ])
      expect(all[3].data).toMatchObject({ type: 'state', state: 'succeeded' })

      const later = await readEvents(
        await api.call('GET', `/v1/runs/${run.id}/events`, { headers: { 'last-event-id': '3' } })
      )
      expect(later.map((e) => e.id)).toEqual(['4'])
      const byQuery = await readEvents(await api.call('GET', `/v1/runs/${run.id}/events?after=2`))
      expect(byQuery.map((e) => e.id)).toEqual(['3', '4'])
    })
  })

  it('follows a run while it works and ends the stream when it is over', async () => {
    const { executor, release } = gated()
    await withApi('runs-api-follow', executor, async (api) => {
      const run = await (await api.submit(request)).json()
      await untilState(api, run.id, ['running'])
      const stream = api.call('GET', `/v1/runs/${run.id}/events`)
      await sleep(50)
      release()
      const events = await readEvents(await stream)
      expect(events.map((e) => e.event)).toEqual(['state', 'state', 'task', 'log', 'state'])
      expect(events[3].data).toMatchObject({ text: 'compiling', stream: 'stdout' })
      expect(events[4].data).toMatchObject({ state: 'succeeded' })
    })
  })

  it('refuses a repository the caller does not list, or the server can not read, before anything is queued', async () => {
    await withApi('runs-api-repos', undefined, async (api) => {
      const other = { ...request, source: { type: 'ref', repo: 'github.com/other/tool', ref: 'main' } }
      const refused = await api.submit(other)
      expect(refused.status).toBe(403)
      expect((await refused.json()).error).toContain('you may not run from github.com/other/tool')

      // bob may name any gitlab repository, but this server is configured for github only
      const gitlab = { ...request, source: { type: 'ref', repo: 'gitlab.corp.com/a/b/c', ref: 'main' } }
      const unreadable = await api.submit(gitlab, 'bob')
      expect(unreadable.status).toBe(400)
      expect((await unreadable.json()).error).toContain('this server can not read gitlab.corp.com/a/b/c')
      expect((await (await api.call('GET', '/v1/runs')).json()).runs).toEqual([])
    })
  })

  it('pins the ref to a commit when the run is submitted, or says why it can not', async () => {
    await withApi('runs-api-pin', undefined, async (api) => {
      const run = await (await api.submit(request)).json()
      expect(run.source).toEqual({ type: 'ref', repo: REPO, ref: 'main', commit: COMMIT })

      const missing = await api.submit({ ...request, source: { type: 'ref', repo: REPO, ref: 'missing' } })
      expect(missing.status).toBe(400)
      expect((await missing.json()).error).toContain('there is no branch or tag missing')
      const both = await api.submit({ ...request, source: { type: 'ref', repo: REPO, ref: 'both' } })
      expect((await both.json()).error).toContain('both a branch and a tag')

      // a url is not a repository, however it is written
      for (const repo of ['https://user:pw@github.com/corp/x', 'github.com/corp/../x', 'file:///etc', '-x/y']) {
        const bad = await api.submit({ ...request, source: { type: 'ref', repo, ref: 'main' } })
        expect(bad.status).toBe(400)
      }
    })
  })

  it('runs a task from a git ref of the repository of the server and streams it', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'hammerkit-api-repository-'))
    try {
      const git = (...args: string[]) =>
        execFileSync(
          'git',
          ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args],
          { cwd: repository }
        )
      git('init', '--quiet', '--initial-branch=main')
      writeFileSync(join(repository, 'input.txt'), 'from-the-ref')
      git('add', '.')
      git('commit', '--quiet', '-m', 'one')
      await withApi(
        'runs-api-git',
        undefined,
        async (api) => {
          const published = await api.call('PUT', '/v1/definitions/payments', {
            sub: 'bob',
            body: {
              files: { '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [cat input.txt]\n  show:\n    cmds: [cat]\n' },
            },
          })
          const hash = (await published.json()).hash
          const run = await (await api.submit({ ...request, definition: { name: 'payments', hash } })).json()
          expect((await untilState(api, run.id, ['succeeded', 'failed'])).state).toBe('succeeded')
          const events = await readEvents(await api.call('GET', `/v1/runs/${run.id}/events`))
          expect(events.map((e) => e.data.text ?? '').join('')).toContain('from-the-ref')
          expect(events.some((e) => e.event === 'task' && e.data.state === 'succeeded')).toBe(true)

          // the arguments of a run reach its last command
          const show = await (
            await api.submit({
              ...request,
              definition: { name: 'payments', hash },
              tasks: ['show'],
              options: { args: ['input.txt'] },
            })
          ).json()
          expect(show.plan.show.command).toMatch(/^cat 'input.txt'$/)
          expect((await untilState(api, show.id, ['succeeded', 'failed'])).state).toBe('succeeded')
          const shown = await readEvents(await api.call('GET', `/v1/runs/${show.id}/events`))
          expect(shown.map((e) => e.data.text ?? '').join('')).toContain('from-the-ref')
        },
        '',
        { url: () => repository }
      )
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
  })

  it('shows how each task of a real run went, and reads its log', async () => {
    const repository = mkdtempSync(join(tmpdir(), 'hammerkit-api-results-'))
    try {
      execFileSync('git', ['init', '--quiet', '--initial-branch=main'], { cwd: repository })
      writeFileSync(join(repository, 'input.txt'), 'from-the-ref')
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'add', '.'],
        { cwd: repository }
      )
      execFileSync(
        'git',
        ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', 'commit', '-qm', 'one'],
        { cwd: repository }
      )
      await withApi(
        'runs-api-results',
        undefined,
        async (api) => {
          const published = await api.call('PUT', '/v1/definitions/payments', {
            sub: 'bob',
            body: {
              files: {
                '.hammerkit.yaml': [
                  'tasks:',
                  '  build:',
                  '    cmds: [cat input.txt]',
                  '  test:',
                  '    deps: [build]',
                  '    cmds:',
                  '      - echo checking',
                  "      - echo 'expected 1 to be 2'",
                  '      - exit 4',
                  '',
                ].join('\n'),
              },
            },
          })
          const hash = (await published.json()).hash
          const run = await (
            await api.submit({
              ...request,
              tasks: ['test'],
              options: { skipDeps: false },
              definition: { name: 'payments', hash },
            })
          ).json()
          expect(run.results).toEqual({})
          // waits until the run is over, however long the checkout takes
          let finished = await (await api.call('GET', `/v1/runs/${run.id}?wait=60s`)).json()
          while (!['succeeded', 'failed'].includes(finished.state)) {
            finished = await (await api.call('GET', `/v1/runs/${run.id}?wait=60s`)).json()
          }
          expect(finished.state).toBe('failed')
          expect(finished.results.build).toMatchObject({
            status: 'succeeded',
            durationMs: expect.any(Number),
            cache: { hit: false },
            lastLog: ['from-the-ref'],
          })
          expect(finished.results.test).toMatchObject({
            status: 'failed',
            exitCode: 4,
            durationMs: expect.any(Number),
            lastLog: ['checking', 'expected 1 to be 2'],
          })

          const logs = await api.call('GET', `/v1/runs/${run.id}/logs?task=test&grep=expected`)
          expect(logs.status).toBe(200)
          expect(await logs.json()).toEqual({
            lines: [{ line: 2, task: 'test', stream: 'stdout', text: 'expected 1 to be 2', match: true }],
            total: 2,
            truncated: false,
          })
          const tail = await (await api.call('GET', `/v1/runs/${run.id}/logs?tail=1`)).json()
          expect(tail.lines.map((line: { text: string }) => line.text)).toEqual(['expected 1 to be 2'])
          // the list is short, the results are read one run at a time
          const list = await (await api.call('GET', '/v1/runs')).json()
          expect(list.runs[0].results).toBeUndefined()
        },
        '',
        { url: () => repository }
      )
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
  })

  it('waits for a run to finish, or answers how it stands when the time is up', async () => {
    const { executor, release } = gated()
    await withApi('runs-api-wait', executor, async (api) => {
      const run = await (await api.submit(request)).json()
      await untilState(api, run.id, ['running'])
      const started = Date.now()
      const early = await (await api.call('GET', `/v1/runs/${run.id}?wait=200ms`)).json()
      expect(early.state).toBe('running')
      expect(Date.now() - started).toBeGreaterThanOrEqual(150)
      expect(early.results.build).toMatchObject({ status: 'running', lastLog: ['compiling'] })

      const waiting = api.call('GET', `/v1/runs/${run.id}?wait=30s`)
      await sleep(50)
      release()
      expect((await (await waiting).json()).state).toBe('succeeded')

      const wrong = await api.call('GET', `/v1/runs/${run.id}?wait=soon`)
      expect(wrong.status).toBe(400)
      expect((await wrong.json()).error).toBe('wait is a duration up to 50s, for example 30s')
      expect((await api.call('GET', `/v1/runs/${run.id}?wait=1s`, { sub: 'carol' })).status).toBe(404)
    })
  })

  it('waits at most 50 seconds, and not at all for a run the caller can not see', async () => {
    const { executor, release } = gated()
    await withApi('runs-api-wait-bounds', executor, async (api) => {
      const run = await (await api.submit(request)).json()
      await untilState(api, run.id, ['running'])
      // leaving it out is how not to wait
      for (const wait of ['0s', '0', '']) {
        expect((await api.call('GET', `/v1/runs/${run.id}?wait=${wait}`)).status).toBe(400)
      }
      const wait = vi.spyOn(RunRegistry.prototype, 'wait')
      try {
        const long = api.call('GET', `/v1/runs/${run.id}?wait=5m`)
        await sleep(50)
        release()
        expect((await long).status).toBe(200)
        expect(wait.mock.calls[0][2]).toBe(50_000)
      } finally {
        wait.mockRestore()
      }
      const started = Date.now()
      expect((await api.call('GET', `/v1/runs/${run.id}?wait=30s`, { sub: 'carol' })).status).toBe(404)
      expect(Date.now() - started).toBeLessThan(5_000)
    })
  })

  it('shows the log of a run waiting for approval to who may approve it, and to nobody else', async () => {
    await withApi('runs-api-approver-logs', done, async (api) => {
      const run = await (await api.submit({ ...request, tasks: ['deploy'] })).json()
      expect(run.state).toBe('awaiting-approval')
      // bob uses prod, which the run waits for
      expect((await api.call('GET', `/v1/runs/${run.id}/logs`, { sub: 'bob' })).status).toBe(200)
      const started = Date.now()
      const waited = await api.call('GET', `/v1/runs/${run.id}?wait=100ms`, { sub: 'bob' })
      expect(waited.status).toBe(200)
      expect((await waited.json()).state).toBe('awaiting-approval')
      expect(Date.now() - started).toBeGreaterThanOrEqual(80)
      // carol uses no account of the run
      expect((await api.call('GET', `/v1/runs/${run.id}/logs`, { sub: 'carol' })).status).toBe(404)
      expect((await api.call('GET', `/v1/runs/${run.id}?wait=10ms`, { sub: 'carol' })).status).toBe(404)
    })
  })

  it('shows the log of a run to its owner only, and says what is wrong with a query', async () => {
    const { executor, release } = gated()
    await withApi('runs-api-logs', executor, async (api) => {
      const run = await (await api.submit(request)).json()
      await untilState(api, run.id, ['running'])
      const logs = await (await api.call('GET', `/v1/runs/${run.id}/logs`)).json()
      expect(logs).toEqual({
        lines: [{ line: 1, task: 'build', stream: 'stdout', text: 'compiling' }],
        total: 1,
        truncated: false,
      })
      expect((await api.call('GET', `/v1/runs/${run.id}/logs`, { sub: 'carol' })).status).toBe(404)
      const wrong = await api.call('GET', `/v1/runs/${run.id}/logs?tail=1&from=1`)
      expect(wrong.status).toBe(400)
      expect((await wrong.json()).error).toMatch(/^tail and from do not go together/)
      expect((await api.call('POST', `/v1/runs/${run.id}/logs`)).status).toBe(405)
      release()
      await untilState(api, run.id, ['succeeded'])
    })
  })

  it('answers 429 to a caller over their limits, and still takes the runs of others', async () => {
    const { executor } = gated()
    await withApi(
      'runs-api-limits',
      executor,
      async (api) => {
        expect((await api.submit({ ...request, tasks: ['deploy'] })).status).toBe(202)
        const over = await api.submit({ ...request, tasks: ['deploy'] })
        expect(over.status).toBe(429)
        expect((await over.json()).error).toContain('1 runs waiting for an approval')
        // bob uses prod, so his run needs no approval
        expect((await api.submit(request, 'bob')).status).toBe(202)
      },
      '',
      fakeRepos,
      'limits: { waiting: 1 }'
    )
  })

  it('stops a run that takes longer than the maximum', async () => {
    await withApi(
      'runs-api-duration',
      gated().executor,
      async (api) => {
        const run = await (await api.submit(request)).json()
        const ended = await untilState(api, run.id, ['failed'])
        expect(ended.error).toMatch(/took longer than 1s and was stopped/)
      },
      '',
      fakeRepos,
      'maxDuration: 1s'
    )
  })

  it('keeps its runs over a restart, the waiting ones wait on', async () => {
    await withApi('runs-api-restart', done, async (api) => {
      const finished = await (await api.submit(request)).json()
      await untilState(api, finished.id, ['succeeded'])
      const waiting = await (await api.submit({ ...request, tasks: ['deploy'] })).json()

      await api.restart(gated().executor)

      const kept = await (await api.call('GET', `/v1/runs/${finished.id}`)).json()
      expect(kept).toMatchObject({ state: 'succeeded', tasks: ['build'] })
      const events = await readEvents(await api.call('GET', `/v1/runs/${finished.id}/events`))
      expect(events.map((e) => e.event)).toContain('task')
      const held = await (await api.call('GET', `/v1/runs/${waiting.id}`)).json()
      expect(held.state).toBe('awaiting-approval')
      // and it can still be approved
      expect((await api.call('POST', `/v1/approvals/${waiting.id}/approve`, { sub: 'bob' })).status).toBe(200)
      expect((await untilState(api, waiting.id, ['running'])).state).toBe('running')
    })
  })

  it('reads the entitlements again on a reload, and keeps the old ones when the new are wrong', async () => {
    await withApi('runs-api-reload', done, async (api) => {
      expect((await api.submit(request, 'carol')).status).toBe(202)
      const config = await readServerConfig(api.env, api.file)

      // carol loses her entitlement, and something that needs a restart changes
      const next = {
        ...config,
        entitlements: config.entitlements.filter((e) => e.subject?.sub !== 'carol'),
        approvals: { ...config.approvals, maxWaiting: 7 },
      }
      expect(api.server.reload(next)).toEqual({ restart: ['approvals'] })
      expect((await api.submit(request, 'carol')).status).toBe(403)
      expect((await api.submit(request)).status).toBe(202)
      expect(api.log.join('\n')).toContain('reloaded 3 entitlements, restart for: approvals')

      const wrong = {
        ...next,
        entitlements: [{ ...next.entitlements[0], accounts: { 'op-unknown': 'use' as const } }],
      }
      expect(() => api.server.reload(wrong)).toThrow(/no account op-unknown/)
      expect((await api.submit(request)).status).toBe(202)
    })
  })

  it('pulls a version back for who publishes it or uses its accounts, and no run starts from it', async () => {
    await withApi('runs-api-yank', done, async (api) => {
      const hash = request.definition.hash
      const path = (action: string) => `/v1/definitions/payments/${hash}/${action}`
      // dave uses an account, but not one of this version
      expect((await api.call('POST', path('yank'), { sub: 'dave' })).status).toBe(403)
      expect((await api.call('POST', path('yank'), { sub: 'nobody' })).status).toBe(404)
      expect(
        (await api.call('POST', `/v1/definitions/payments/sha256:${'0'.repeat(64)}/yank`, { sub: 'bob' })).status
      ).toBe(404)

      // carol uses op-payments-ci, which the version works with
      const yanked = await api.call('POST', path('yank'), { sub: 'carol', body: { reason: 'leaks a token' } })
      expect(yanked.status).toBe(200)
      expect(await yanked.json()).toMatchObject({
        hash,
        yanked: { by: { sub: 'carol' }, reason: 'leaks a token', at: expect.any(String) },
      })
      expect(api.log.join('\n')).toContain(`yank payments@${hash}`)

      const refused = await api.submit(request, 'carol')
      expect(refused.status).toBe(409)
      expect((await refused.json()).error).toContain('was yanked: leaks a token')
      // it is not latest any more, the version stays for the record
      expect((await api.call('GET', '/v1/definitions/payments/latest', { sub: 'bob' })).status).toBe(404)
      expect((await api.submit({ ...request, definition: { name: 'payments', hash: 'latest' } })).status).toBe(400)
      const versions = await (await api.call('GET', '/v1/definitions/payments', { sub: 'bob' })).json()
      expect(versions.versions[0].yanked.reason).toBe('leaks a token')

      // letting it go on is for who publishes
      expect((await api.call('POST', path('unyank'), { sub: 'carol' })).status).toBe(403)
      const back = await api.call('POST', path('unyank'), { sub: 'bob' })
      expect(back.status).toBe(200)
      expect((await back.json()).yanked).toBeUndefined()
      expect((await api.submit(request, 'carol')).status).toBe(202)
    })
  })

  it('keeps a yanked version over a restart', async () => {
    await withApi('runs-api-yank-restart', done, async (api) => {
      const hash = request.definition.hash
      await api.call('POST', `/v1/definitions/payments/${hash}/yank`, { sub: 'bob' })
      await api.restart()
      expect((await api.submit(request, 'carol')).status).toBe(409)
    })
  })

  it('answers 404 or 405 for what is not a run call', async () => {
    await withApi('runs-api-routes', done, async (api) => {
      expect((await api.call('GET', '/v1/runs/not-a-run-id')).status).toBe(404)
      expect((await api.call('GET', '/v1/runs/run_AAAAAAAAAAAAAAAA')).status).toBe(404)
      expect((await api.call('DELETE', '/v1/runs')).status).toBe(405)
      expect((await api.call('GET', '/v1/runs/run_AAAAAAAAAAAAAAAA/cancel')).status).toBe(405)
      expect((await api.call('POST', '/v1/runs/run_AAAAAAAAAAAAAAAA')).status).toBe(405)
    })
  })
})
