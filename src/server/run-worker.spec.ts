import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, Writable } from 'stream'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { runProgram } from '../run-program'
import { WorkerMessage, workerMain } from './run-worker'
import { hostEnvs } from '../testing/host-env'

function sink(): { stream: Writable; messages: () => WorkerMessage[] } {
  const chunks: string[] = []
  return {
    stream: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk.toString())
        callback()
      },
    }),
    messages: () =>
      chunks
        .join('')
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line)),
  }
}

describe('workerMain', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hammerkit-worker-'))
    writeFileSync(
      join(directory, '.hammerkit.yaml'),
      'tasks:\n  hello:\n    cmds: [echo hello-from-the-run]\n  broken:\n    cmds: [exit 3]\n'
    )
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  async function run(input: unknown) {
    const stdin = new PassThrough()
    stdin.end(typeof input === 'string' ? input : JSON.stringify(input))
    const out = sink()
    // PSModulePath too: Windows PowerShell takes half a minute to start without it
    const envs = { PATH: process.env.PATH, PSModulePath: process.env.PSModulePath }
    await workerMain(stdin, out.stream, envs, directory, new AbortController())
    return out.messages()
  }

  const base = {
    entry: '',
    tasks: ['hello'],
    options: { cache: 'none' as const },
    accounts: [],
    catalog: { providers: {}, accounts: {} },
  }

  it('reports the output and the tasks of the run, and how it ended', async () => {
    const messages = await run({ ...base, entry: join(directory, '.hammerkit.yaml') })
    expect(messages[messages.length - 1]).toEqual({ kind: 'result', ok: true })
    const events = messages.flatMap((m) => (m.kind === 'event' ? [m.event] : []))
    expect(events).toContainEqual({ type: 'task', task: 'hello', state: 'running' })
    expect(events).toContainEqual({ type: 'task', task: 'hello', state: 'succeeded' })
    expect(events.map((e) => (e.type === 'log' ? e.text : '')).join('')).toContain('hello-from-the-run')
  })

  it('says which task failed, and that a failure is not a cancellation', async () => {
    const messages = await run({ ...base, tasks: ['broken'], entry: join(directory, '.hammerkit.yaml') })
    expect(messages[messages.length - 1]).toEqual({ kind: 'result', ok: false, error: 'broken failed' })
  })

  it('says when the input is not a run', async () => {
    const messages = await run('{"tasks": "build"}')
    expect(messages).toEqual([{ kind: 'result', ok: false, error: expect.stringContaining('could not be read') }])
    expect(await run('not json')).toEqual([
      { kind: 'result', ok: false, error: expect.stringContaining('could not be read') },
    ])
  })

  it('says when the build file has no such task', async () => {
    const messages = await run({ ...base, tasks: ['nope'], entry: join(directory, '.hammerkit.yaml') })
    expect(messages[messages.length - 1]).toMatchObject({ kind: 'result', ok: false })
  })
})

describe('workerMain cancel', () => {
  let directory: string

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'hammerkit-worker-'))
    writeFileSync(join(directory, '.hammerkit.yaml'), 'tasks:\n  slow:\n    cmds: [echo started, sleep 30]\n')
  })

  afterEach(() => rmSync(directory, { recursive: true, force: true }))

  it('stops the run when the server writes cancel after it', async () => {
    const stdin = new PassThrough()
    const out = sink()
    const input = {
      entry: join(directory, '.hammerkit.yaml'),
      tasks: ['slow'],
      options: { cache: 'none' },
      accounts: [],
      catalog: { providers: {}, accounts: {} },
    }
    // the server keeps the standard input open after the run
    stdin.write(`${JSON.stringify(input)}\n`)
    const started = Date.now()
    const done = workerMain(stdin, out.stream, hostEnvs(), directory, new AbortController())
    while (!JSON.stringify(out.messages()).includes('started') && Date.now() - started < 30_000) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    stdin.write('cancel\n')
    await done
    const messages = out.messages()
    expect(messages[messages.length - 1]).toEqual({ kind: 'result', ok: false, error: 'the run was cancelled' })
    expect(Date.now() - started).toBeLessThan(25_000)
  })
})

describe('hammerkit server-run', () => {
  it('is the command the server starts: the run on stdin, the report on stdout', async () => {
    await createTestCase('server-run-command', {
      '.hammerkit.yaml': 'tasks:\n  hello:\n    cmds: [echo said-hello]\n',
    }).setup(async (cwd, environment) => {
      const stdin = new PassThrough()
      stdin.end(
        JSON.stringify({
          entry: join(cwd, '.hammerkit.yaml'),
          tasks: ['hello'],
          options: { cache: 'none' },
          accounts: [],
          catalog: { providers: {}, accounts: {} },
        })
      )
      const spy = vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as typeof process.stdin)
      try {
        const out = memoryStream()
        environment.stdout = out.stream
        // what the server hands the process; a copy of process.env loses its case-insensitive
        // keys on Windows, where PATH is `Path`
        environment.processEnvs = hostEnvs()
        await runProgram(environment, ['hammerkit', 'server-run'], true)
        const lines = out
          .read()
          .split('\n')
          .filter((line) => line.length > 0)
          .map((line) => JSON.parse(line))
        expect(lines[lines.length - 1]).toEqual({ kind: 'result', ok: true })
        expect(JSON.stringify(lines)).toContain('said-hello')
      } finally {
        spy.mockRestore()
      }
    })
  })
})
