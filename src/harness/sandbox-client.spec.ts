import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { itExceptWindows, SANDBOX_REPO, withSandboxServer } from '../testing/sandbox-server'
import {
  checkSandboxPath,
  downloadRunArtifact,
  exitCodeOf,
  fetchFailure,
  followRun,
  getRun,
  oneAtATime,
  quotePosix,
  readTextUpTo,
  SandboxClient,
  SandboxClientError,
  ServerConnection,
  submitRun,
  toSandboxPath,
} from './sandbox-client'
import { Reconnecting, showUrl } from './reconnect'
import { RETRY_HEADER } from '../server/http'
import { getHarnessEnvironment } from './connect'
import { getTokenSource } from '../remote/token-source'

describe('sandbox paths', () => {
  it('maps the working directory of a harness onto the root of the sandbox', () => {
    const root = join(process.cwd(), 'work')
    expect(toSandboxPath(root, join(root, 'src', 'a.ts'))).toBe('src/a.ts')
    expect(toSandboxPath(root, root)).toBe('')
    expect(toSandboxPath(root, 'src/../lib/b.ts')).toBe('lib/b.ts')
    expect(() => toSandboxPath(root, join(root, '..', 'other'))).toThrow(/is outside of the sandbox/)
    expect(() => toSandboxPath(root, '../x')).toThrow(SandboxClientError)
  })

  it('takes relative paths below the root only', () => {
    expect(checkSandboxPath('./src/a.ts')).toBe('src/a.ts')
    expect(checkSandboxPath('src\\a.ts')).toBe('src/a.ts')
    expect(checkSandboxPath('.')).toBe('')
    expect(() => checkSandboxPath('/etc/passwd')).toThrow(/outside/)
    expect(() => checkSandboxPath('a/../../b')).toThrow(/outside/)
  })

  it('takes calls one at a time in the order they came, past one that failed', async () => {
    const inTurn = oneAtATime()
    const order: string[] = []
    const call = (name: string, ms: number, fail = false) =>
      inTurn(async () => {
        order.push(`${name} starts`)
        await new Promise((resolve) => setTimeout(resolve, ms))
        order.push(`${name} ends`)
        if (fail) {
          throw new Error(name)
        }
        return name
      })
    const calls = [call('bash', 30), call('edit', 1, true), call('read', 1)]
    expect(await Promise.allSettled(calls)).toEqual([
      { status: 'fulfilled', value: 'bash' },
      { status: 'rejected', reason: new Error('edit') },
      { status: 'fulfilled', value: 'read' },
    ])
    expect(order).toEqual(['bash starts', 'bash ends', 'edit starts', 'edit ends', 'read starts', 'read ends'])
  })

  it('quotes a directory for the shell and reads the exit code of a result', () => {
    expect(quotePosix("it's here")).toBe(`'it'\\''s here'`)
    expect(exitCodeOf(undefined)).toBeNull()
    expect(exitCodeOf({ status: 'cached', lastLog: [] })).toBe(0)
    expect(exitCodeOf({ status: 'failed', exitCode: 2, lastLog: [] })).toBe(2)
    expect(exitCodeOf({ status: 'cancelled', lastLog: [] })).toBeNull()
  })
})

const VIEW = { id: 'sbx_1', repo: 'r', ref: 'main', commit: 'c', bytes: 0, busy: false, run: null }

// a server of the test's own, for answers the hammerkit server never gives
async function withHttp(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (url: string) => Promise<void>
): Promise<void> {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
  } finally {
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

// a port nothing listens on, for a server that is away
async function freePort(): Promise<number> {
  const probe = createServer()
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve))
  const port = (probe.address() as AddressInfo).port
  await new Promise((resolve) => probe.close(resolve))
  return port
}

// a server that is away for `awayMs`, as during a restart, then answers with `handler`
async function withRestart(
  awayMs: number,
  handler: (req: IncomingMessage, res: ServerResponse) => void,
  fn: (url: string) => Promise<void>
): Promise<void> {
  const port = await freePort()
  const server = createServer(handler)
  const started = new Promise<void>((resolve) =>
    setTimeout(() => server.listen(port, '127.0.0.1', () => resolve()), awayMs)
  )
  try {
    await fn(`http://127.0.0.1:${port}`)
  } finally {
    await started
    server.closeAllConnections()
    await new Promise((resolve) => server.close(resolve))
  }
}

const QUICK = { windowMs: 5_000, firstDelayMs: 20, maxDelayMs: 100 }

describe('reconnecting to a server that restarts', () => {
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { 'content-type': 'application/json', ...headers }).end(JSON.stringify(body))
  // the 503 of a hammerkit server that shuts down and took nothing of the request
  const shuttingDown = (res: ServerResponse) =>
    json(res, 503, { error: 'the server is shutting down' }, { [RETRY_HEADER]: 'safe' })
  const quick = (url: string, more: Partial<ServerConnection> = {}): ServerConnection => ({
    url,
    token: async () => 'tok',
    reconnect: QUICK,
    ...more,
  })

  it('asks again while the server is away, and says once that it reconnects and once that it is back', async () => {
    const said: string[] = []
    await withRestart(
      300,
      (req, res) => json(res, 200, VIEW),
      async (url) => {
        expect(await SandboxClient.get(quick(url, { say: (line) => said.push(line) }), 'sbx_1')).toEqual(VIEW)
        expect(said).toEqual([
          expect.stringMatching(new RegExp(`^unable to reach ${url}: .*ECONNREFUSED.*, reconnecting for up to 5s$`)),
          `${url} is back`,
        ])
      }
    )
  })

  it('asks again on a broken connection or a proxy that has no server behind it, for a read', async () => {
    const answers: ((res: ServerResponse) => void)[] = [
      (res) => res.socket?.destroy(),
      (res) => res.writeHead(502).end(),
      (res) => res.writeHead(504).end(),
      (res) => json(res, 200, VIEW),
    ]
    let asked = 0
    const said: string[] = []
    await withHttp(
      (req, res) => answers[asked++](res),
      async (url) => {
        expect(await SandboxClient.get(quick(url, { say: (line) => said.push(line) }), 'sbx_1')).toEqual(VIEW)
        expect(asked).toBe(4)
        expect(said).toEqual([expect.stringContaining('reconnecting'), `${url} is back`])
      }
    )
  })

  it('submits a run again that the server refused while it shut down, once it takes it', async () => {
    let submits = 0
    const said: string[] = []
    await withHttp(
      (req, res) => (++submits <= 2 ? shuttingDown(res) : json(res, 201, { id: 'run_1' })),
      async (url) => {
        expect(await submitRun(quick(url, { say: (line) => said.push(line) }), { tasks: ['test'] })).toEqual({
          id: 'run_1',
        })
        expect(submits).toBe(3)
        expect(said).toEqual([`${url} answered 503, reconnecting for up to 5s`, `${url} is back`])
      }
    )
  })

  it('never submits a run again that a proxy answered, the server behind it may have taken it', async () => {
    for (const status of [502, 503, 504]) {
      let submits = 0
      await withHttp(
        (req, res) => {
          submits++
          res.writeHead(status).end()
        },
        async (url) => {
          await expect(submitRun(quick(url), { tasks: ['test'] })).rejects.toMatchObject({ status })
          expect(submits).toBe(1)
        }
      )
    }
  })

  it('never sends a call again that changes the sandbox when its connection broke after it was sent', async () => {
    const asked: string[] = []
    await withHttp(
      (req, res) => {
        asked.push(`${req.method} ${req.url}`)
        req.resume()
        res.socket?.destroy()
      },
      async (url) => {
        const connection = quick(url)
        const client = new SandboxClient(connection, VIEW, { hash: 'h', shell: '' })
        const edit = [{ op: 'replace' as const, path: 'a.ts', old_string: '1', new_string: '2' }]
        await expect(submitRun(connection, { tasks: ['test'] })).rejects.toThrow(`unable to reach ${url}`)
        await expect(SandboxClient.create(connection, 'r', 'main')).rejects.toThrow(`unable to reach ${url}`)
        await expect(client.push('work', 'message')).rejects.toThrow(`unable to reach ${url}`)
        await expect(client.edit(edit)).rejects.toThrow(`unable to reach ${url}`)
        expect(asked).toEqual([
          'POST /v1/runs',
          'POST /v1/sandboxes',
          'POST /v1/sandboxes/sbx_1/push',
          'POST /v1/sandboxes/sbx_1/edits',
        ])
      }
    )
  })

  it('sends a dry run of an edit again, which changes nothing', async () => {
    let asked = 0
    await withHttp(
      (req, res) => {
        req.resume()
        return ++asked === 1 ? res.socket?.destroy() : json(res, 200, { files: [] })
      },
      async (url) => {
        const client = new SandboxClient(quick(url), VIEW, { hash: 'h', shell: '' })
        expect(await client.edit([{ op: 'delete', path: 'a.ts' }], true)).toEqual([])
        expect(asked).toBe(2)
      }
    )
  })

  it('submits again only when every address of the server refused the connection', async () => {
    // how node's fetch reports a name with two addresses, one refused and one reset
    const failed = (...codes: string[]) =>
      Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error(''), {
          name: 'AggregateError',
          code: codes[0],
          errors: codes.map((code) => Object.assign(new Error(code), { code })),
        }),
      })
    const tries = async (repeat: 'always' | 'unsent', error: unknown) => {
      let sent = 0
      const reconnecting = new Reconnecting({
        url: 'http://server',
        timing: QUICK,
        fail: (message) => new Error(message),
      })
      const answered = reconnecting.send(async () => {
        return ++sent === 1 ? { error, message: 'unable to reach http://server' } : { response: new Response('{}') }
      }, repeat)
      await answered.catch(() => undefined)
      return sent
    }
    expect(await tries('unsent', failed('ECONNREFUSED', 'ECONNRESET'))).toBe(1)
    expect(await tries('unsent', failed('ECONNREFUSED', 'ECONNREFUSED'))).toBe(2)
    expect(await tries('always', failed('ECONNREFUSED', 'ECONNRESET'))).toBe(2)
    expect(await tries('always', failed('ENOTFOUND'))).toBe(1)
  })

  it('gives up on a server that does not come back within the window, and says which', async () => {
    const url = `http://127.0.0.1:${await freePort()}`
    const started = Date.now()
    await expect(SandboxClient.get(quick(url, { reconnect: { ...QUICK, windowMs: 300 } }), 'sbx_1')).rejects.toThrow(
      new RegExp(`^${url} did not come back within 300ms: unable to reach ${url}: .*ECONNREFUSED`)
    )
    expect(Date.now() - started).toBeGreaterThanOrEqual(300)
  })

  it('waits no longer than the window, however long a try may take', async () => {
    let asked = 0
    await withHttp(
      // away, then an answer that never comes, as a download that hangs
      (req, res) => (++asked === 1 ? res.writeHead(503).end() : undefined),
      async (url) => {
        const started = Date.now()
        const connection = quick(url, { reconnect: { ...QUICK, windowMs: 400 } })
        await expect(downloadRunArtifact(connection, 'run_1', 0, join(tmpdir(), 'never.tgz'))).rejects.toThrow(
          `${url} did not come back within 400ms`
        )
        expect(Date.now() - started).toBeLessThan(2_000)
        expect(asked).toBe(2)
      }
    )
  })

  it('asks for a new token within the window of the call, not on top of it', async () => {
    let asked = 0
    let renewed = 0
    const started = Date.now()
    await withHttp(
      (req, res) => (Date.now() - started > 300 && ++asked === 1 ? json(res, 401, {}) : res.writeHead(503).end()),
      async (url) => {
        const connection = quick(url, { reconnect: { ...QUICK, windowMs: 400 }, renew: async () => void renewed++ })
        await expect(SandboxClient.get(connection, 'sbx_1')).rejects.toThrow(`${url} did not come back within 400ms`)
        expect(renewed).toBe(1)
        expect(Date.now() - started).toBeLessThan(600)
      }
    )
  })

  it('stops waiting for the server, and a try on the way, when the command is stopped', async () => {
    const abort = new AbortController()
    const away = quick(`http://127.0.0.1:${await freePort()}`, {
      reconnect: { ...QUICK, windowMs: 60_000 },
      signal: abort.signal,
    })
    setTimeout(() => abort.abort(), 100)
    await expect(getRun(away, 'run_1')).rejects.toThrow('ECONNREFUSED')
    await withHttp(
      () => undefined,
      async (url) => {
        const stopped = new AbortController()
        setTimeout(() => stopped.abort(), 100)
        const started = Date.now()
        await expect(getRun(quick(url, { signal: stopped.signal }), 'run_1')).rejects.toThrow(
          `stopped while asking ${url}`
        )
        expect(Date.now() - started).toBeLessThan(2_000)
      }
    )
  })

  it('follows a run on from the line it got to before the server went away', async () => {
    const log = ['one', 'two', 'three', 'four', 'five'].map((text, i) => ({
      line: i + 1,
      task: 't',
      stream: 'stdout',
      text,
    }))
    // before the restart the run printed three lines; then it is away, refused while it shuts
    // down and gone while it starts; after it, the run printed all and succeeded
    let phase: 'before' | 'away' | 'after' = 'before'
    let awayFor = 0
    const froms: string[] = []
    await withHttp(
      (req, res) => {
        const route = req.url?.startsWith('/v1/runs/run_1/logs') ? 'logs' : 'run'
        if (phase === 'away') {
          if (++awayFor === 4) {
            phase = 'after'
          }
          if (awayFor % 2) {
            res.writeHead(503).end()
          } else {
            res.socket?.destroy()
          }
          return
        }
        if (route === 'logs') {
          const from = Number(new URL(req.url ?? '', 'http://x').searchParams.get('from'))
          froms.push(String(from))
          json(res, 200, { lines: log.slice(from - 1, phase === 'after' ? 5 : 3), truncated: false })
          return
        }
        const state = phase === 'after' ? 'succeeded' : 'running'
        // the next read of the log finds the server away
        phase = phase === 'before' ? 'away' : phase
        json(res, 200, { id: 'run_1', state, tasks: ['t'], results: {} })
      },
      async (url) => {
        const printed: string[] = []
        const said: string[] = []
        const run = { id: 'run_1', state: 'running', tasks: ['t'], results: {} }
        const followed = await followRun(quick(url, { say: (line) => said.push(line) }), run as never, {
          onLine: (line) => printed.push(line.text),
        })
        expect(followed.run.state).toBe('succeeded')
        expect(printed).toEqual(['one', 'two', 'three', 'four', 'five'])
        expect(froms).toEqual(['1', '4', '6'])
        expect(said).toHaveLength(2)
      }
    )
  })

  it('stops waiting for a server that is away when the follow is stopped', async () => {
    const url = `http://127.0.0.1:${await freePort()}`
    const abort = new AbortController()
    const run = { id: 'run_1', state: 'running', tasks: ['t'], results: {} }
    const followed = followRun(quick(url, { reconnect: { ...QUICK, windowMs: 60_000 } }), run as never, {
      signal: abort.signal,
      detach: true,
    })
    setTimeout(() => abort.abort(), 100)
    expect((await followed).run).toBe(run)
  })

  it('never asks again on a request the server refuses', async () => {
    for (const status of [400, 404, 409, 500]) {
      let asked = 0
      await withHttp(
        (req, res) => {
          asked++
          json(res, status, { error: 'no' })
        },
        async (url) => {
          await expect(SandboxClient.get(quick(url), 'sbx_1')).rejects.toMatchObject({ status })
          await expect(submitRun(quick(url), {})).rejects.toMatchObject({ status })
          expect(asked).toBe(2)
        }
      )
    }
  })

  it('says the address of the server without the user and password it holds', () => {
    expect(showUrl('https://me:secret@build.corp/')).toBe('https://build.corp/')
    expect(showUrl('https://me:secret@build.corp')).toBe('https://build.corp')
    expect(showUrl('https://build.corp')).toBe('https://build.corp')
  })
})

describe('following a run', () => {
  it('waits for the server to take the cancel before it gives up on a run', async () => {
    const run = { id: 'run_1', state: 'awaiting-approval', tasks: ['deploy'], results: {} }
    let cancelled = false
    await withHttp(
      (req, res) => {
        const answer = (body: unknown, ms = 0) =>
          setTimeout(() => {
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(body))
          }, ms)
        if (req.method === 'POST' && req.url === '/v1/runs/run_1/cancel') {
          // a slow answer, as through a load balancer or a token command that runs again
          setTimeout(() => (cancelled = true), 300)
          answer(run, 300)
        } else if (req.url?.startsWith('/v1/runs/run_1/logs')) {
          answer({ lines: [], truncated: false })
        } else {
          answer(run, 20)
        }
      },
      async (url) => {
        const abort = new AbortController()
        const followed = followRun({ url, token: async () => 'tok' }, run as never, { signal: abort.signal })
        await new Promise((resolve) => setTimeout(resolve, 50))
        abort.abort()
        await expect(followed).rejects.toThrow('the run was cancelled')
        expect(cancelled).toBe(true)
      }
    )
  })

  it('only stops following a run it was told to detach from, and never cancels it', async () => {
    const run = { id: 'run_1', state: 'up', tasks: [], results: {} }
    const asked: string[] = []
    await withHttp(
      (req, res) => {
        asked.push(`${req.method} ${req.url?.split('?')[0]}`)
        const body = req.url?.startsWith('/v1/runs/run_1/logs')
          ? { lines: [{ line: 1, task: 'web', stream: 'stdout', text: 'listening' }], truncated: false }
          : run
        setTimeout(() => {
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(JSON.stringify(body))
        }, 20)
      },
      async (url) => {
        const abort = new AbortController()
        const lines: string[] = []
        const followed = followRun({ url, token: async () => 'tok' }, run as never, {
          signal: abort.signal,
          detach: true,
          onLine: (line) => lines.push(line.text),
        })
        await new Promise((resolve) => setTimeout(resolve, 100))
        abort.abort()
        const { run: last } = await followed
        expect(last).toMatchObject({ id: 'run_1', state: 'up' })
        expect(lines).toContain('listening')
        // give a cancel sent on the abort the time to arrive
        await new Promise((resolve) => setTimeout(resolve, 100))
        expect(asked.filter((call) => call.startsWith('POST'))).toEqual([])
      }
    )
  })
})

describe('reading a page of an endpoint', () => {
  it('reads no more of a page than it shows, however much the app sends', async () => {
    let sent = 0
    let closed = false
    await withHttp(
      (req, res) => {
        if (req.url?.startsWith('/v1/runs/run_1')) {
          const host = `http://${req.headers.host}`
          res.writeHead(200, { 'content-type': 'application/json' })
          res.end(
            JSON.stringify({
              id: 'run_1',
              state: 'up',
              up: { endpoints: [{ service: 'web', port: 80, url: `${host}/` }] },
            })
          )
          return
        }
        // an app that never stops answering
        res.writeHead(200, { 'content-type': 'text/plain' })
        res.on('close', () => (closed = true))
        const chunk = 'x'.repeat(16 * 1024)
        const write = () => {
          while (!closed && sent < 64 * 1024 * 1024 && res.write(chunk)) {
            sent += chunk.length
          }
          if (!closed && sent < 64 * 1024 * 1024) {
            res.once('drain', write)
          }
        }
        write()
      },
      async (url) => {
        const client = new SandboxClient({ url, token: async () => 'tok' }, VIEW as never, { hash: 'h', shell: '' })
        const page = await client.fetchEndpoint('run_1', '/big', undefined, undefined, 100_000)
        expect(page.status).toBe(200)
        expect(page.truncated).toBe(true)
        expect(page.body).toBe('x'.repeat(100_000))
        await vi.waitFor(() => expect(closed).toBe(true), { timeout: 5000 })
        expect(sent).toBeLessThan(16 * 1024 * 1024)
      }
    )
  })

  it('reads a page up to the limit in full and cuts no character in half', async () => {
    const answer = (body: Buffer) => new Response(body)
    expect(await readTextUpTo(answer(Buffer.from('hello')), 5)).toEqual({ text: 'hello', truncated: false })
    expect(await readTextUpTo(answer(Buffer.from('hello!')), 5)).toEqual({ text: 'hello', truncated: true })
    // ä is two bytes: the cut at byte 2 falls inside the second one
    expect(await readTextUpTo(answer(Buffer.from('aä')), 2)).toEqual({ text: 'a', truncated: true })
    expect(await readTextUpTo(new Response(null), 5)).toEqual({ text: '', truncated: false })
  })
})

describe('following a service run that moved', () => {
  const c = 'c'.repeat(40)
  const d = 'd'.repeat(40)
  const base = { id: 'run_1', tasks: [], results: {}, moved: { logFrom: 5 } }

  // a server whose run is each of `runs` in turn, the last one from then on
  async function follow(submitted: object, runs: object[]) {
    let polls = 0
    const froms: string[] = []
    let result: unknown
    await withHttp(
      (req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        if (req.url?.startsWith('/v1/runs/run_1/logs')) {
          froms.push(new URL(req.url, 'http://x').searchParams.get('from') ?? '')
          res.end(JSON.stringify({ lines: [], truncated: false }))
        } else {
          res.end(JSON.stringify(runs[Math.min(polls++, runs.length - 1)]))
        }
      },
      async (url) => {
        result = await followRun({ url, token: async () => 'tok' }, submitted as never, { untilUp: true })
      }
    )
    return { result: result as { run: { state: string } }, polls, froms }
  }

  it('ends at once for a run that sleeps, which only changed its commit', async () => {
    const asleep = { ...base, state: 'asleep', source: { type: 'ref', commit: d }, moves: [{ commit: d }] }
    const { result, polls, froms } = await follow(asleep, [asleep])
    expect(result.run.state).toBe('asleep')
    expect(polls).toBe(0)
    expect(froms).toEqual(['5'])
  })

  it('follows a run that is up until it is at the commit, or did not get there', async () => {
    const moving = { ...base, state: 'up', source: { type: 'ref', commit: c }, moving: { commit: d } }
    const there = { ...moving, moving: undefined, source: { type: 'ref', commit: d }, moves: [{ commit: d }] }
    expect((await follow(moving, [moving, moving, there])).polls).toBe(3)
    const back = { ...moving, moving: undefined, moves: [{ commit: d, error: 'build failed' }] }
    expect((await follow(moving, [moving, back])).result.run).toMatchObject({ moves: [{ error: 'build failed' }] })
    // a move that starts the services again goes through the states of a start
    const restarting = { ...moving, state: 'running' }
    expect((await follow(moving, [restarting, { ...there, state: 'running' }, there])).polls).toBe(3)
  })

  it('stops following once a later move takes its place', async () => {
    const moving = { ...base, state: 'up', source: { type: 'ref', commit: c }, moving: { commit: d } }
    const later = { ...moving, moving: { commit: 'e'.repeat(40) } }
    expect((await follow(moving, [later])).polls).toBe(1)
  })
})

describe('tokens', () => {
  const secret = 'SECRET-refresh-token'

  it('never sends or repeats a token that is more than one word', async () => {
    for (const token of [`${secret}\nmore`, `Bearer ${secret}`, `${secret}\0x`]) {
      const failure = SandboxClient.get({ url: 'http://127.0.0.1:1', token: async () => token }, 'sbx_1')
      await expect(failure).rejects.toThrow('the token is not a single line of visible characters')
      await expect(failure).rejects.not.toThrow(secret)
    }
  })

  it('asks for a new token once when the server stops taking one, never twice', async () => {
    const seen: (string | undefined)[] = []
    await withHttp(
      (req, res) => {
        seen.push(req.headers.authorization)
        const ok = req.headers.authorization === 'Bearer tok-2'
        res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' })
        res.end(JSON.stringify(ok ? VIEW : { error: 'expired' }))
      },
      async (url) => {
        let renewed = 0
        const connection: ServerConnection = {
          url,
          token: async () => `tok-${renewed + 1}`,
          renew: async () => {
            renewed++
          },
        }
        expect(await SandboxClient.get(connection, 'sbx_1')).toEqual(VIEW)
        expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-2'])
        expect(renewed).toBe(1)

        // a server that takes no token at all: one renew, then the answer
        seen.length = 0
        const refused = SandboxClient.get({ url, token: async () => 'tok-1', renew: async () => undefined }, 'sbx_1')
        await expect(refused).rejects.toMatchObject({ status: 401 })
        expect(seen).toEqual(['Bearer tok-1', 'Bearer tok-1'])
      }
    )
  })

  it('never follows a redirect, so the token and files stay with the server', async () => {
    const elsewhere: (string | undefined)[] = []
    await withHttp(
      (req, res) => {
        elsewhere.push(req.headers.authorization)
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(VIEW))
      },
      async (other) =>
        withHttp(
          (req, res) => {
            res.writeHead(307, { location: `${other.replace('127.0.0.1', 'localhost')}${req.url}` })
            res.end()
          },
          async (url) => {
            await expect(SandboxClient.get({ url, token: async () => 'tok-1' }, 'sbx_1')).rejects.toThrow(
              /unable to reach/
            )
            expect(elsewhere).toEqual([])
          }
        )
    )
  })

  it('says why the server could not be reached', async () => {
    const closed = createServer()
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${(closed.address() as AddressInfo).port}`
    await new Promise((resolve) => closed.close(resolve))
    const connection = { url, token: async () => 'tok-1', reconnect: { ...QUICK, windowMs: 100 } }
    await expect(SandboxClient.get(connection, 'sbx_1')).rejects.toThrow(
      `unable to reach ${url}: fetch failed: connect ECONNREFUSED`
    )

    // how node's fetch reports a self-signed certificate
    const untrusted = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('self-signed certificate'), { code: 'DEPTH_ZERO_SELF_SIGNED_CERT' }),
    })
    expect(fetchFailure(untrusted)).toBe(
      'fetch failed: self-signed certificate (DEPTH_ZERO_SELF_SIGNED_CERT), this machine does not trust the ' +
        'certificate of the server: name its CA in NODE_EXTRA_CA_CERTS'
    )
    expect(fetchFailure(new Error('redirect'))).toBe('redirect')
  })

  it('refuses the output of a token command that prints more than the token', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hammerkit-token-'))
    try {
      const command = (output: string) => {
        const script = join(dir, 'token.js')
        writeFileSync(script, `process.stdout.write(${JSON.stringify(output)})`)
        return `node "${script}"`
      }
      const environment = getHarnessEnvironment()
      const server = { url: 'http://127.0.0.1:1', issuer: 'https://idp.example.com' }
      environment.processEnvs = {
        ...environment.processEnvs,
        HAMMERKIT_TOKEN_COMMAND: command(`{\n  "refresh_token": "${secret}"\n}\n`),
      }
      const failure = getTokenSource(environment, 'corp', server).token()
      await expect(failure).rejects.toThrow('HAMMERKIT_TOKEN_COMMAND printed more than a token')
      await expect(failure).rejects.not.toThrow(secret)

      environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_TOKEN_COMMAND: command('abc.def\n') }
      expect(await getTokenSource(environment, 'corp', server).token()).toBe('abc.def')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs the token command of a server again when the token is renewed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hammerkit-token-'))
    try {
      // prints tok-1, tok-2, ... one more on every run
      const script = join(dir, 'token.js')
      const counter = join(dir, 'count')
      writeFileSync(
        script,
        `const fs = require('fs'); const n = (fs.existsSync(${JSON.stringify(counter)}) ? ` +
          `Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')) : 0) + 1; ` +
          `fs.writeFileSync(${JSON.stringify(counter)}, String(n)); process.stdout.write('tok-' + n)`
      )
      const environment = getHarnessEnvironment()
      const env = { ...environment.processEnvs }
      delete env.HAMMERKIT_TOKEN_COMMAND
      delete env.HAMMERKIT_TOKEN
      environment.processEnvs = env
      const source = getTokenSource(environment, 'corp', {
        url: 'http://127.0.0.1:1',
        issuer: 'https://idp.example.com',
        tokenCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(script)}`,
      })
      expect(await source.token()).toBe('tok-1')
      expect(await source.token()).toBe('tok-1')
      await source.renew?.()
      expect(await source.token()).toBe('tok-2')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('sandbox client', () => {
  it('reads, writes, searches and edits the files of a sandbox', async () => {
    await withSandboxServer('harness-client-files', async ({ client }) => {
      expect(await client.stat('input.txt')).toMatchObject({ type: 'file', size: 10 })
      expect(await client.stat('missing.txt')).toBeUndefined()
      expect((await client.readRaw('input.txt')).toString()).toBe('from-main\n')
      await expect(client.readRaw('src')).rejects.toThrow(/src is a directory/)

      expect(await client.writeRaw('docs/new file.md', '# New\n')).toMatchObject({
        path: 'docs/new file.md',
        change: 'added',
      })
      expect((await client.read('docs/new file.md')).content).toBe('     1\t# New')
      const tree = await client.tree({ glob: '**/*.md' })
      expect(tree.entries.map((entry) => entry.path)).toEqual(['docs/new file.md'])

      await client.edit([{ op: 'replace', path: 'src/app.ts', old_string: '41', new_string: '42' }])
      const search = await client.search({ pattern: 'answer = \\d+', output_mode: 'content' })
      expect(search.matches).toEqual([{ path: 'src/app.ts', line: 2, text: 'export const answer = 42' }])
      await expect(
        client.edit([{ op: 'replace', path: 'src/app.ts', old_string: 'nothing', new_string: 'x' }])
      ).rejects.toMatchObject({ status: 422, message: expect.stringMatching(/old_string is not in src\/app\.ts/) })

      const changes = await client.changes()
      expect(changes.files.map((file) => `${file.status} ${file.path}`)).toEqual([
        'added docs/new file.md',
        'modified src/app.ts',
      ])
      expect(await client.diff('diff')).toContain('+export const answer = 42')
      await expect(client.read('../outside')).rejects.toThrow(/outside of the sandbox/)
    })
  })

  it('sees an edit of the same size made in the second the sandbox was created', async () => {
    await withSandboxServer('harness-client-racy', async ({ connection, build }) => {
      const view = await SandboxClient.create(connection, SANDBOX_REPO, 'main')
      const client = new SandboxClient(connection, view, { hash: build, shell: 'sh' })
      await client.edit([{ op: 'replace', path: 'src/app.ts', old_string: '41', new_string: '42' }])
      // past the second of the checkout, where git would take the file for unchanged
      await new Promise((resolve) => setTimeout(resolve, 1100))
      expect((await client.changes()).files.map((file) => file.path)).toEqual(['src/app.ts'])
      expect(await client.diff('diff')).toContain('+export const answer = 42')
    })
  })

  itExceptWindows('runs a shell command on the sandbox and follows its output to the exit code', async () => {
    await withSandboxServer('harness-client-exec', async ({ client }) => {
      const lines: string[] = []
      const ran = await client.exec('cat app.ts && echo "it\'s $((40 + 2))"', 'src', {
        onLine: (line) => lines.push(line),
      })
      expect(ran.exitCode).toBe(0)
      expect(ran.output).toContain('export const greeting = "hello"')
      expect(lines).toContain("it's 42")
      expect(ran.run.tasks).toEqual(['sh'])

      // what a command writes stays for the next one, and for the file API
      await client.exec('echo made > made.txt', '')
      expect((await client.readRaw('made.txt')).toString()).toBe('made\n')

      const failed = await client.exec('echo out; echo err >&2; exit 7', '')
      expect(failed.exitCode).toBe(7)
      expect(failed.output.split('\n')).toEqual(expect.arrayContaining(['out', 'err']))

      // a directory that is not there stops the whole command, not only its first part
      const missing = await client.exec('true; echo ran > ran.txt; echo b', 'nowhere')
      expect(missing.exitCode).toBe(1)
      expect(missing.output.split('\n')).not.toContain('b')
      expect(await client.stat('ran.txt')).toBeUndefined()
      expect(await client.stat('nowhere/ran.txt')).toBeUndefined()
      // and a directory that looks like an option of cd is a directory
      await client.writeRaw('-P/f.txt', 'f\n')
      expect((await client.exec('ls', '-P')).output).toBe('f.txt')

      const task = await client.runTask('fail')
      expect(task.exitCode).toBe(3)
      expect(task.result?.lastLog).toContain('broken')
    })
  })

  itExceptWindows("stops a command after its own timeout, below the shell task's longer one", async () => {
    await withSandboxServer('harness-client-timeout', async ({ client }) => {
      const started = Date.now()
      const ran = await client.exec('sleep 30', '', { timeoutSeconds: 1 })
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(ran.run.options).toEqual({ args: [expect.any(String)], maxTimeout: '1s' })
      expect(ran.exitCode).toBeNull()
      expect(ran.result?.error).toBe('timed out after 1s')
    })
  })

  itExceptWindows('refuses a command of a shell that sees none of the files of the sandbox', async () => {
    await withSandboxServer('harness-client-blind-shell', async ({ client }) => {
      // a shell that sees none of the files says so instead of running on an empty directory
      const blind = new SandboxClient(client.connection, client.sandbox, {
        hash: client.build.hash,
        shell: 'elsewhere',
      })
      const said: string[] = []
      await expect(blind.exec('echo lost > lost.txt', '', { onLine: (line) => said.push(line) })).rejects.toThrow(
        `the shell task elsewhere of ${client.build.hash} sees none of the files of the sandbox, a shell task in a container needs mounts: [.] to work on them`
      )
      expect(said).toEqual([])
      expect(await client.stat('lost.txt')).toBeUndefined()

      // on a sandbox without files, the empty directory is the sandbox: the command runs
      const files = (await client.tree({ depth: 64 })).entries.filter((entry) => entry.type !== 'directory')
      await client.edit(files.map((entry) => ({ op: 'delete' as const, path: entry.path })))
      expect((await blind.exec('echo ran', '')).output).toBe('ran')
    })
  })
})

describe('a sandbox without a shell', () => {
  it('refuses a command before it asks the server', async () => {
    const connection = {
      url: 'http://127.0.0.1:9',
      token: async () => {
        throw new Error('no call expected')
      },
    }
    const view = { id: 'sbx_1', repo: SANDBOX_REPO, ref: 'main', commit: 'c', bytes: 0, busy: false, run: null }
    const client = new SandboxClient(connection, view, { hash: 'sha256:1', shell: '' })
    await expect(client.exec('ls', '')).rejects.toThrow(
      'there is no shell on this sandbox (HAMMERKIT_SHELL is empty), run a task instead'
    )
  })
})
