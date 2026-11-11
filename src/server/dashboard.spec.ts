import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { IncomingMessage, ServerResponse } from 'http'
import { tmpdir } from 'os'
import { join } from 'path'
import { Readable } from 'stream'
import { DashboardContext, DashboardSession, DECIDE_WITHIN_MS, handleDashboard } from './dashboard'
import { RunExecutor, RunRegistry } from './runs'
import { serverConfigSchema } from './server-config'

const ISS = 'https://idp.corp'
const person = (sub: string) => ({ iss: ISS, sub, groups: [], claims: {} })
const alice = person('alice')
const bob = person('bob')
const carol = person('carol')
const olga = person('olga')
const nobody = person('nobody')

const config = serverConfigSchema.parse({
  listen: { port: 0 },
  issuers: [{ issuer: ISS, audience: 'hammerkit' }],
  runs: { env: { allow: ['PATH'] }, activity: 'everyone' },
  entitlements: [
    { subject: { iss: ISS, sub: 'alice' }, repos: ['github.com/corp/*'], builds: 'run' },
    { subject: { iss: ISS, sub: 'bob' }, repos: ['github.com/corp/*'], builds: 'run' },
    { subject: { iss: ISS, sub: 'carol' }, repos: ['github.com/corp/*'], builds: 'publish' },
    { subject: { iss: ISS, sub: 'olga' }, observe: true },
  ],
})

const spec = (tasks: string[]) => ({
  definition: 'sha256:' + 'a'.repeat(64),
  tasks,
  accounts: [],
  source: { type: 'ref' as const, repo: 'github.com/corp/shop', ref: 'main', commit: 'c'.repeat(40) },
  options: {},
})

const NOW = Date.parse('2026-11-07T12:00:00Z')
const sign = (value: string) => `signed:${Buffer.from(value).toString('base64url')}`

interface Answer {
  status: number
  headers: Record<string, string | number>
  body: string
}

describe('dashboard', () => {
  let assets: string
  let calls: { sub: string; method: string; path: string; body: string }[]
  let logged: string[]
  let registry: RunRegistry

  beforeEach(() => {
    assets = mkdtempSync(join(tmpdir(), 'hammerkit-dashboard-'))
    mkdirSync(join(assets, 'assets'))
    writeFileSync(join(assets, 'index.html'), '<!doctype html><div id="root"></div>')
    writeFileSync(join(assets, 'assets', 'index-abc.css'), 'body{}')
    writeFileSync(join(assets, 'logo.png'), 'png')
    calls = []
    logged = []
    registry = new RunRegistry({ executor: { execute: async () => undefined } })
  })

  afterEach(async () => {
    await registry.close()
    rmSync(assets, { recursive: true, force: true })
  })

  async function open(
    principal: typeof alice,
    path: string,
    options: {
      method?: string
      headers?: Record<string, string>
      body?: string
      context?: Partial<DashboardContext>
    } = {}
  ): Promise<Answer> {
    const req = Object.assign(Readable.from(options.body ? [Buffer.from(options.body)] : []), {
      method: options.method ?? 'GET',
      headers: options.headers ?? {},
    }) as unknown as IncomingMessage
    const answer: Answer = { status: 0, headers: {}, body: '' }
    const res = {
      setHeader: (name: string, value: string) => (answer.headers[name] = value),
      writeHead: (code: number, sent: Record<string, string> = {}) => {
        answer.status = code
        Object.assign(answer.headers, sent)
      },
      end: (sent?: string | Buffer) => (answer.body = sent ? sent.toString() : ''),
    } as unknown as ServerResponse
    const context: DashboardContext = {
      config,
      registry,
      sign,
      log: (line) => logged.push(line),
      now: () => NOW,
      assets,
      session: 'token',
      // the API answers what it was asked, and by whom
      api: async (who, request, response, url) => {
        let body = ''
        for await (const chunk of request) {
          body += chunk
        }
        calls.push({ sub: who.sub, method: request.method ?? '', path: url.pathname + url.search, body })
        response.writeHead(200, { 'content-type': 'application/json' })
        response.end('{}')
      },
      ...options.context,
    }
    await handleDashboard(context, principal, req, res, new URL(path, 'http://hammerkit.run.test'))
    return answer
  }

  const sessionOf = async (principal: typeof alice, context?: Partial<DashboardContext>) => {
    const answer = await open(principal, '/api/session', { context })
    expect(answer.status).toBe(200)
    return JSON.parse(answer.body) as DashboardSession
  }

  it('tells the app who looks, what they see, and until when the sign-in decides', async () => {
    expect(await sessionOf(alice)).toEqual({
      iss: ISS,
      sub: 'alice',
      observe: false,
      // runs.activity: everyone
      seesOthers: true,
      publishes: false,
      csrf: sign(`dashboard\0csrf\0${ISS}\0alice\0token`),
      decideWithinMinutes: 15,
    })
    expect(await sessionOf(carol)).toMatchObject({ publishes: true })
    // with the name of their sign-in, when it has one
    expect(await sessionOf({ ...bob, claims: { email: 'bob@corp.com' } })).toMatchObject({ name: 'bob@corp.com' })
    expect(await sessionOf(olga)).toMatchObject({ observe: true, seesOthers: true })
    // a sign-in in the browser: its token dies with its session, it decides for 15 minutes
    const signedIn = await sessionOf(alice, { session: 'session:123', signedInAt: NOW - 60_000 })
    expect(signedIn.csrf).toBe(sign(`dashboard\0csrf\0${ISS}\0alice\0session:123`))
    expect(signedIn.decideUntil).toBe(new Date(NOW - 60_000 + DECIDE_WITHIN_MS).toISOString())
    // with runs.activity: involved, only their own and what they are involved in
    expect(
      await sessionOf(alice, { config: { ...config, runs: { ...config.runs, activity: 'involved' } } })
    ).toMatchObject({ seesOthers: false })
    expect((await open(nobody, '/api/session')).status).toBe(403)
    expect((await open(nobody, '/api/v1/overview')).status).toBe(403)
  })

  it('passes what the pages read and the buttons do on to the API, and nothing else', async () => {
    const { csrf } = await sessionOf(alice)
    const json = { 'content-type': 'application/json', 'x-hammerkit-csrf': csrf }
    for (const path of [
      '/api/v1/overview',
      '/api/v1/runs?scope=visible&state=queued,running',
      '/api/v1/runs/run_aaaaaaaaaaaaaaaa',
      '/api/v1/runs/run_aaaaaaaaaaaaaaaa/logs?tail=200&task=build',
      '/api/v1/tasks',
      '/api/v1/capacity',
      '/api/v1/approvals',
      `/api/v1/proposals/sha256:${'b'.repeat(64)}/files`,
      // the build files, and a version of one, from the tasks and runs that ran it
      '/api/v1/definitions',
      `/api/v1/definitions/sha256:${'c'.repeat(64)}`,
      `/api/v1/definitions/sha256:${'c'.repeat(64)}/files`,
      // the person's sandboxes, one of them, and what changed in it
      '/api/v1/sandboxes',
      '/api/v1/sandboxes/sbx_aaaaaaaaaaaaaaaa',
      '/api/v1/sandboxes/sbx_aaaaaaaaaaaaaaaa/changes?format=diff',
    ]) {
      expect((await open(alice, path)).status).toBe(200)
    }
    const stop = await open(alice, '/api/v1/runs/run_aaaaaaaaaaaaaaaa/cancel', { method: 'POST', headers: json })
    expect(stop.status).toBe(200)
    const extend = await open(alice, '/api/v1/runs/run_aaaaaaaaaaaaaaaa/extend', {
      method: 'POST',
      headers: json,
      body: '{"ttl":"8h"}',
    })
    expect(extend.status).toBe(200)
    const wake = await open(alice, '/api/v1/runs/run_aaaaaaaaaaaaaaaa/wake', { method: 'POST', headers: json })
    expect(wake.status).toBe(200)
    // a sandbox of one's own goes, with the token of the sign-in
    const sandbox = '/api/v1/sandboxes/sbx_aaaaaaaaaaaaaaaa'
    expect((await open(alice, sandbox, { method: 'DELETE', headers: json })).status).toBe(200)
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      'GET /v1/overview',
      'GET /v1/runs?scope=visible&state=queued,running',
      'GET /v1/runs/run_aaaaaaaaaaaaaaaa',
      'GET /v1/runs/run_aaaaaaaaaaaaaaaa/logs?tail=200&task=build',
      'GET /v1/tasks',
      'GET /v1/capacity',
      'GET /v1/approvals',
      `GET /v1/proposals/sha256:${'b'.repeat(64)}/files`,
      'GET /v1/definitions',
      `GET /v1/definitions/sha256:${'c'.repeat(64)}`,
      `GET /v1/definitions/sha256:${'c'.repeat(64)}/files`,
      'GET /v1/sandboxes',
      'GET /v1/sandboxes/sbx_aaaaaaaaaaaaaaaa',
      'GET /v1/sandboxes/sbx_aaaaaaaaaaaaaaaa/changes?format=diff',
      'POST /v1/runs/run_aaaaaaaaaaaaaaaa/cancel',
      'POST /v1/runs/run_aaaaaaaaaaaaaaaa/extend',
      'POST /v1/runs/run_aaaaaaaaaaaaaaaa/wake',
      'DELETE /v1/sandboxes/sbx_aaaaaaaaaaaaaaaa',
    ])
    expect(calls[15]).toMatchObject({ sub: 'alice', body: '{"ttl":"8h"}' })
    expect(logged).toEqual([
      `dashboard POST /v1/runs/run_aaaaaaaaaaaaaaaa/cancel iss=${ISS} sub=alice`,
      `dashboard POST /v1/runs/run_aaaaaaaaaaaaaaaa/extend iss=${ISS} sub=alice`,
      `dashboard POST /v1/runs/run_aaaaaaaaaaaaaaaa/wake iss=${ISS} sub=alice`,
      `dashboard DELETE /v1/sandboxes/sbx_aaaaaaaaaaaaaaaa iss=${ISS} sub=alice`,
    ])
    calls = []
    // a read is not done, a button is not read
    expect((await open(alice, '/api/v1/runs/run_aaaaaaaaaaaaaaaa/cancel')).status).toBe(405)
    expect((await open(alice, '/api/v1/overview', { method: 'POST', headers: json })).status).toBe(405)
    // what the pages never do: start a run, publish, follow events, change sandboxes
    expect((await open(alice, '/api/v1/runs', { method: 'POST', headers: json })).status).toBe(405)
    expect((await open(alice, '/api/v1/definitions', { method: 'POST', headers: json })).status).toBe(405)
    // nor make or change a sandbox, nor remove anything else, nor without the token of the sign-in
    expect((await open(alice, '/api/v1/sandboxes', { method: 'POST', headers: json })).status).toBe(405)
    expect((await open(alice, '/api/v1/sandboxes', { method: 'DELETE', headers: json })).status).toBe(405)
    expect((await open(alice, '/api/v1/runs/run_aaaaaaaaaaaaaaaa', { method: 'DELETE', headers: json })).status).toBe(
      405
    )
    expect((await open(alice, sandbox, { method: 'POST', headers: json })).status).toBe(405)
    const unsigned = { 'content-type': 'application/json', 'x-hammerkit-csrf': sign('forged') }
    expect((await open(alice, sandbox, { method: 'DELETE', headers: unsigned })).status).toBe(403)
    expect((await open(alice, sandbox, { method: 'DELETE' })).status).toBe(403)
    for (const path of [
      `/api/v1/definitions/sha256:${'c'.repeat(64)}/yank`,
      '/api/v1/runs/run_aaaaaaaaaaaaaaaa/events',
      // the files of a sandbox, and what writes them
      '/api/v1/sandboxes/sbx_aaaaaaaaaaaaaaaa/files/package.json',
      '/api/v1/sandboxes/sbx_aaaaaaaaaaaaaaaa/tree',
      '/api/v1/sandboxes/sbx_aaaaaaaaaaaaaaaa/edits',
      '/api/v1/sandboxes/sbx_aaaaaaaaaaaaaaaa/push',
      '/api/v1/sandboxes/sbx_short',
      // a way round, to what stays refused
      '/api/v1/runs/../sandboxes/sbx_aaaaaaaaaaaaaaaa/tree',
      '/api/v1/runs/run_short',
      '/api/v2/overview',
    ]) {
      expect((await open(alice, path)).status).toBe(404)
    }
    expect((await open(alice, '/api/v1/runs/run_aaaaaaaaaaaaaaaa/cancel', { method: 'DELETE' })).status).toBe(405)
    // without the token of the sign-in
    const forged = { 'content-type': 'application/json', 'x-hammerkit-csrf': sign('forged') }
    for (const headers of [{ 'content-type': 'application/json' }, forged]) {
      const refused = await open(alice, '/api/v1/runs/run_aaaaaaaaaaaaaaaa/cancel', { method: 'POST', headers })
      expect(refused.status).toBe(403)
    }
    // with bob's
    const bobs = (await sessionOf(bob)).csrf
    expect(
      (
        await open(alice, '/api/v1/runs/run_aaaaaaaaaaaaaaaa/cancel', {
          method: 'POST',
          headers: { ...json, 'x-hammerkit-csrf': bobs },
        })
      ).status
    ).toBe(403)
    expect(calls).toEqual([])
  })

  it('lets a sign-in of the last minutes approve and reject, and an API token always', async () => {
    const decide = async (signedInAt: number | undefined, path: string) => {
      const context = { session: 'session:1', ...(signedInAt !== undefined ? { signedInAt } : {}) }
      const { csrf } = await sessionOf(alice, context)
      return open(alice, path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hammerkit-csrf': csrf },
        body: '{"reason":"not now"}',
        context,
      })
    }
    const run = '/api/v1/approvals/run_aaaaaaaaaaaaaaaa/reject'
    const version = `/api/v1/proposals/sha256:${'b'.repeat(64)}/approve`
    expect((await decide(NOW - DECIDE_WITHIN_MS, run)).status).toBe(200)
    expect((await decide(undefined, version)).status).toBe(200)
    for (const path of [run, version]) {
      const late = await decide(NOW - DECIDE_WITHIN_MS - 1, path)
      expect(late.status).toBe(403)
      expect(JSON.parse(late.body)).toEqual({
        error: 'approving and rejecting take a sign-in of the last 15 minutes',
        signInAgain: true,
      })
    }
    // stop does not need it
    const { csrf } = await sessionOf(alice, { session: 'session:1', signedInAt: 0 })
    const stop = await open(alice, '/api/v1/runs/run_aaaaaaaaaaaaaaaa/cancel', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-hammerkit-csrf': csrf },
      context: { session: 'session:1', signedInAt: 0 },
    })
    expect(stop.status).toBe(200)
    expect(calls.map((call) => call.path)).toEqual([
      '/v1/approvals/run_aaaaaaaaaaaaaaaa/reject',
      `/v1/proposals/sha256:${'b'.repeat(64)}/approve`,
      '/v1/runs/run_aaaaaaaaaaaaaaaa/cancel',
    ])
    expect(calls[0].body).toBe('{"reason":"not now"}')
  })

  it('gives the log of a run as a text file to who may read it', async () => {
    const executor: RunExecutor = {
      execute: async (_run, { emit }) => {
        emit({ type: 'log', task: 'build', stream: 'stdout', text: 'compiled 12 files' })
        emit({ type: 'log', task: 'db', stream: 'stderr', text: 'database system is ready' })
      },
    }
    await registry.close()
    registry = new RunRegistry({ executor })
    const run = registry.submit(alice, spec(['build']))
    for (let i = 0; i < 400 && registry.peek(run.id)?.state !== 'succeeded'; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    const all = await open(alice, `/api/runs/${run.id}/log.txt`)
    expect(all.status).toBe(200)
    expect(all.headers['content-type']).toBe('text/plain; charset=utf-8')
    expect(all.headers['content-disposition']).toBe(`attachment; filename="${run.id}.log"`)
    expect(all.body).toContain('[build] compiled 12 files\n[db] database system is ready\n')
    const one = await open(alice, `/api/runs/${run.id}/log.txt?task=db`)
    expect(one.headers['content-disposition']).toBe(`attachment; filename="${run.id}-db.log"`)
    expect(one.body).toBe('database system is ready\n')
    // who observes reads it; who sees the run in the list of activity does not
    expect((await open(olga, `/api/runs/${run.id}/log.txt`)).status).toBe(200)
    expect((await open(bob, `/api/runs/${run.id}/log.txt`)).status).toBe(404)
    expect((await open(alice, '/api/runs/run_aaaaaaaaaaaaaaaa/log.txt')).status).toBe(404)
  })

  it('serves the app: its files by name, and index.html for every page', async () => {
    for (const path of ['/', '/runs/run_aaaaaaaaaaaaaaaa', '/approvals/versions/sha256:abc', '/nope']) {
      const page = await open(alice, path)
      expect(page.status).toBe(200)
      expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
      expect(page.headers['cache-control']).toBe('no-store')
      expect(page.headers['content-security-policy']).toContain("script-src 'self'")
      expect(page.headers['x-frame-options']).toBe('DENY')
      expect(page.body).toContain('<div id="root">')
    }
    const style = await open(alice, '/assets/index-abc.css')
    expect(style.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(style.headers['cache-control']).toBe('public, max-age=31536000, immutable')
    expect(style.body).toBe('body{}')
    const logo = await open(alice, '/logo.png')
    expect(logo.headers['content-type']).toBe('image/png')
    expect(logo.body).toBe('png')
    expect((await open(alice, '/assets/missing.js')).status).toBe(404)
    expect((await open(alice, '/assets/..%2findex.html')).status).toBe(404)
    expect((await open(alice, '/.hammerkit/other')).status).toBe(404)
    expect((await open(alice, '/', { method: 'POST' })).status).toBe(405)
    // the head of a page, without it
    const head = await open(alice, '/', { method: 'HEAD' })
    expect(head.status).toBe(200)
    expect(head.body).toBe('')
    // a server built without its app says so
    rmSync(join(assets, 'index.html'))
    const missing = await open(alice, '/')
    expect(missing.status).toBe(503)
    expect(missing.body).toContain('npm run build:dashboard')
  })
})
