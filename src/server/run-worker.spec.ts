import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, Writable } from 'stream'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { runProgram } from '../run-program'
import { WorkerMessage, workerMain } from './run-worker'

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
    await workerMain(stdin, out.stream, { PATH: process.env.PATH }, directory, new AbortController())
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
    expect(events).toContainEqual(expect.objectContaining({ type: 'task', task: 'hello', state: 'running' }))
    expect(events).toContainEqual(expect.objectContaining({ type: 'task', task: 'hello', state: 'succeeded' }))
    expect(events.map((e) => (e.type === 'log' ? e.text : '')).join('')).toContain('hello-from-the-run')
  })

  it('says which task failed, and that a failure is not a cancellation', async () => {
    const messages = await run({ ...base, tasks: ['broken'], entry: join(directory, '.hammerkit.yaml') })
    expect(messages[messages.length - 1]).toEqual({ kind: 'result', ok: false, error: 'broken failed' })
  })

  it('reports the exit code of a failed task and how long it ran', async () => {
    const messages = await run({ ...base, tasks: ['broken'], entry: join(directory, '.hammerkit.yaml') })
    const events = messages.flatMap((m) => (m.kind === 'event' ? [m.event] : []))
    expect(events).toContainEqual({
      type: 'task',
      task: 'broken',
      state: 'failed',
      exitCode: 3,
      durationMs: expect.any(Number),
    })
  })

  it('says why a task ran, and when it came from the cache', async () => {
    // the process of a run finds its caches through its environment, as the server sets it
    const cache = mkdtempSync(join(tmpdir(), 'hammerkit-worker-cache-'))
    vi.stubEnv('HAMMERKIT_DIR', cache)
    writeFileSync(
      join(directory, '.hammerkit.yaml'),
      [
        'caches:',
        `  default: { method: checksum, backend: { type: local, path: ${JSON.stringify(join(cache, 'backend'))} } }`,
        'tasks:',
        '  build:',
        '    src: [input.txt]',
        '    cmds: [echo built]',
        '',
      ].join('\n')
    )
    writeFileSync(join(directory, 'input.txt'), 'one')
    try {
      const once = async () => {
        const stdin = new PassThrough()
        stdin.end(
          JSON.stringify({
            ...base,
            tasks: ['build'],
            options: { cache: 'checksum' },
            entry: join(directory, '.hammerkit.yaml'),
          })
        )
        const out = sink()
        await workerMain(stdin, out.stream, { PATH: process.env.PATH }, directory, new AbortController())
        return out.messages().flatMap((m) => (m.kind === 'event' && m.event.type === 'task' ? [m.event] : []))
      }
      expect(await once()).toContainEqual({
        type: 'task',
        task: 'build',
        state: 'succeeded',
        durationMs: expect.any(Number),
        causes: ['never cached'],
      })
      expect(await once()).toContainEqual({
        type: 'task',
        task: 'build',
        state: 'cached',
        durationMs: expect.any(Number),
      })
    } finally {
      vi.unstubAllEnvs()
      rmSync(cache, { recursive: true, force: true })
    }
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
