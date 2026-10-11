import { createHash } from 'crypto'
import { join } from 'path'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { createTestCase } from '../testing/test-case'
import { createTestKey, signToken, startTestIssuer } from '../testing/test-issuer'
import { readServerConfig } from './server-config'
import { RunExecutor } from './runs'
import { RunningServer, startServer } from './server'

const policy = `
entitlements:
  - subject: { iss: ISSUER, sub: alice }
    accounts: [op-payments-dev, op-payments-ci]
    default: op-payments-dev
    publish: [payments]
  - subject: { iss: ISSUER, sub: carol }
    accounts: [op-payments-ci]
    source: [ref]
`

// the responses of this api are json
interface JsonResponse extends Response {
  json(): Promise<any>
}

interface Api {
  server: RunningServer
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
  extraConfig = ''
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
        )} }\nissuers:\n  - { issuer: "${idp.url}", audience: hammerkit }\n${policy.replace(
          /ISSUER/g,
          `"${idp.url}"`
        )}${extraConfig}`
      )
      const log: string[] = []
      const server = await startServer(await readServerConfig(env, file), env, {
        log: (line) => log.push(line),
        executor,
      })
      const token = (sub = 'alice') =>
        signToken(key, { iss: idp.url, sub, aud: 'hammerkit', exp: Math.floor(Date.now() / 1000) + 300 })
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
        const published = await call('PUT', '/v1/definitions/payments', { body: bundle })
        if (published.status !== 201) {
          throw new Error(`could not publish the build file: ${published.status}`)
        }
        request.definition.hash = (await published.json()).hash
        await fn({ server, log, token, call, submit })
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
    '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [echo build]\n  test:\n    cmds: [echo test]\n',
  },
}
// the hash is filled in once the build file is published
const request = {
  definition: { name: 'payments', hash: 'latest' },
  tasks: ['build'],
  source: { type: 'ref', ref: 'main' },
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

  it('accepts a run for the default account, executes it and shows its state', async () => {
    await withApi('runs-api-submit', done, async (api) => {
      const response = await api.submit(request)
      expect(response.status).toBe(202)
      const run = await response.json()
      expect(run).toMatchObject({
        definition: { name: 'payments', hash: expect.stringMatching(/^sha256:/) },
        state: 'queued',
        tasks: ['build'],
        account: 'op-payments-dev',
        source: request.source,
      })
      expect(run.owner).toBeUndefined()
      expect(run.id).toMatch(/^run_/)

      const finished = await untilState(api, run.id, ['succeeded', 'failed'])
      expect(finished.state).toBe('succeeded')
      expect(api.log.join('\n')).toMatch(
        new RegExp(`run ${run.id} iss=\\S+ sub=alice account=op-payments-dev source=ref tasks=1`)
      )
      const list = await (await api.call('GET', '/v1/runs')).json()
      expect(list.runs.map((r: { id: string }) => r.id)).toEqual([run.id])
    })
  })

  it('lets a caller pick any of their accounts, and refuses the others', async () => {
    await withApi('runs-api-accounts', done, async (api) => {
      const ci = await api.submit({ ...request, account: 'op-payments-ci' })
      expect(ci.status).toBe(202)
      expect((await ci.json()).account).toBe('op-payments-ci')

      const other = await api.submit({ ...request, account: 'op-prod-deploy' })
      expect(other.status).toBe(403)
      expect(await other.json()).toEqual({ error: 'you may not use the service account op-prod-deploy' })
      expect(api.log.join('\n')).toContain('refuse run')

      // a caller without any entitlement may not run, nor name an account
      expect((await api.submit({ ...request, account: 'op-payments-dev' }, 'mallory')).status).toBe(403)
      const none = await api.submit(request, 'mallory')
      expect(none.status).toBe(403)
      expect((await none.json()).error).toContain('not entitled')
    })
  })

  it('only takes the kind of source the entitlement allows', async () => {
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
      expect((await api.submit(upload, 'alice')).status).toBe(202)
      const unknown = await api.submit({ ...request, source: { type: 'upload', snapshot: `sha256:${'0'.repeat(64)}` } })
      expect(unknown.status).toBe(400)
      expect((await unknown.json()).error).toContain('not known')
      const refused = await api.submit(upload, 'carol')
      expect(refused.status).toBe(403)
      expect((await refused.json()).error).toContain('runs from upload are not allowed')
      expect((await api.submit(request, 'carol')).status).toBe(202)
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
      const unknown = await api.submit({ ...request, tasks: ['build', 'deploy', 'rm-rf'] })
      expect(unknown.status).toBe(400)
      expect((await unknown.json()).error).toBe('payments has no task "deploy", "rm-rf"')
      expect((await api.submit({ ...request, definition: { name: 'payments', hash: 'v2' } })).status).toBe(400)
    })
  })

  it('takes the settings of a run and keeps them with it', async () => {
    await withApi('runs-api-options', done, async (api) => {
      const options = {
        env: 'staging',
        filter: ['unit'],
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
        (await api.submit({ definition: request.definition, source: request.source, options: { filter: ['unit'] } }))
          .status
      ).toBe(202)
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

  it('fails a run with the reason when the server has no repository for the build file', async () => {
    await withApi('runs-api-no-source', undefined, async (api) => {
      const run = await (await api.submit(request)).json()
      const failed = await untilState(api, run.id, ['failed'])
      expect(failed.error).toContain('sources.payments.git')
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
            body: { files: { '.hammerkit.yaml': 'tasks:\n  build:\n    cmds: [cat input.txt]\n' } },
          })
          const hash = (await published.json()).hash
          const run = await (await api.submit({ ...request, definition: { name: 'payments', hash } })).json()
          expect((await untilState(api, run.id, ['succeeded', 'failed'])).state).toBe('succeeded')
          const events = await readEvents(await api.call('GET', `/v1/runs/${run.id}/events`))
          expect(events.map((e) => e.data.text ?? '').join('')).toContain('from-the-ref')
          expect(events.some((e) => e.event === 'task' && e.data.state === 'succeeded')).toBe(true)
        },
        `sources:\n  payments: { git: ${JSON.stringify(repository)} }\n`
      )
    } finally {
      rmSync(repository, { recursive: true, force: true })
    }
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
