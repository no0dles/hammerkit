import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { AddressInfo } from 'net'
import { tmpdir } from 'os'
import { join } from 'path'
import { itExceptWindows, SANDBOX_REPO, withSandboxServer } from '../testing/sandbox-server'
import {
  checkSandboxPath,
  exitCodeOf,
  fetchFailure,
  followRun,
  oneAtATime,
  quotePosix,
  SandboxClient,
  SandboxClientError,
  ServerConnection,
  toSandboxPath,
} from './sandbox-client'
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
    await expect(SandboxClient.get({ url, token: async () => 'tok-1' }, 'sbx_1')).rejects.toThrow(
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
