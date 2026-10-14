import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { PassThrough, Writable } from 'stream'
import { createTestCase } from '../testing/test-case'
import { memoryStream } from '../testing/test-streams'
import { runProgram } from '../run-program'
import { getRunNetwork, WorkerMessage, taskCauses, workerMain } from './run-worker'
import { limitNetwork, parseWorkNetwork } from '../planner/work-network'
import { NetworkSchema } from '../schema/network-schema'
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
    await workerMain(stdin, out.stream, hostEnvs(), directory, new AbortController())
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

  it('refuses a task that reads through a symbolic link of the checkout, before anything runs', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'hammerkit-worker-outside-'))
    try {
      writeFileSync(join(outside, 'token'), 'server token')
      mkdirSync(join(directory, 'data'))
      symlinkSync(outside, join(directory, 'data', 'link'), 'junction')
      writeFileSync(
        join(directory, '.hammerkit.yaml'),
        'tasks:\n  hello:\n    cmds: [echo hello-from-the-run]\n  leak:\n    deps: [hello]\n    src: [data/link/token]\n    cmds: [cat data/link/token]\n'
      )
      const messages = await run({ ...base, tasks: ['leak'], entry: join(directory, '.hammerkit.yaml') })
      expect(messages[messages.length - 1]).toEqual({
        kind: 'result',
        ok: false,
        error: 'leak: src data/link/token goes through the symbolic link data/link',
      })
      expect(messages.filter((m) => m.kind === 'event')).toEqual([])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
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
        await workerMain(stdin, out.stream, hostEnvs(), directory, new AbortController())
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

  const taskEvents = (messages: WorkerMessage[]) =>
    messages.flatMap((m) => (m.kind === 'event' && m.event.type === 'task' ? [m.event] : []))

  it('calls the tasks after a failed one cancelled, and never running', async () => {
    writeFileSync(
      join(directory, '.hammerkit.yaml'),
      'tasks:\n  a:\n    cmds: [exit 3]\n  b:\n    deps: [a]\n    cmds: [echo b]\n'
    )
    const events = taskEvents(await run({ ...base, tasks: ['b'], entry: join(directory, '.hammerkit.yaml') }))
    expect(events).toContainEqual(expect.objectContaining({ task: 'a', state: 'failed', exitCode: 3 }))
    expect(events.filter((e) => e.task === 'b')).toEqual([{ type: 'task', task: 'b', state: 'cancelled' }])
  })

  it('reports a dependency no task needed as skipped, without a duration', async () => {
    const cache = mkdtempSync(join(tmpdir(), 'hammerkit-worker-cache-'))
    vi.stubEnv('HAMMERKIT_DIR', cache)
    writeFileSync(
      join(directory, '.hammerkit.yaml'),
      [
        'caches:',
        `  default: { method: checksum, backend: { type: local, path: ${JSON.stringify(join(cache, 'backend'))} } }`,
        'tasks:',
        '  a:',
        '    src: [a.txt]',
        '    cmds: [echo a]',
        '  b:',
        '    deps: [a]',
        '    src: [b.txt]',
        '    cmds: [echo b]',
        '',
      ].join('\n')
    )
    writeFileSync(join(directory, 'a.txt'), 'a')
    writeFileSync(join(directory, 'b.txt'), 'b')
    try {
      const input = { ...base, tasks: ['b'], options: { cache: 'checksum' }, entry: join(directory, '.hammerkit.yaml') }
      expect(taskEvents(await run(input))).toContainEqual(expect.objectContaining({ task: 'a', state: 'succeeded' }))
      // b comes from the cache, so nothing needs a
      const events = taskEvents(await run(input))
      expect(events).toContainEqual(expect.objectContaining({ task: 'b', state: 'cached' }))
      expect(events.filter((e) => e.task === 'a')).toEqual([{ type: 'task', task: 'a', state: 'skipped' }])
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

  it('appends the arguments to the last command of the task', async () => {
    writeFileSync(join(directory, '.hammerkit.yaml'), 'tasks:\n  say:\n    cmds: [echo]\n')
    const messages = await run({
      ...base,
      tasks: ['say'],
      options: { ...base.options, args: ['from-the-arguments'] },
      entry: join(directory, '.hammerkit.yaml'),
    })
    expect(messages[messages.length - 1]).toEqual({ kind: 'result', ok: true })
    const text = messages.map((m) => (m.kind === 'event' && m.event.type === 'log' ? m.event.text : '')).join('')
    expect(text).toContain('from-the-arguments')
  })

  it('runs a task with arguments uncached, unless the run names a cache method', async () => {
    // a source of its own, so no cache entry of an earlier test run matches
    writeFileSync(join(directory, 'input.txt'), directory)
    writeFileSync(join(directory, '.hammerkit.yaml'), 'tasks:\n  say:\n    src: [input.txt]\n    cmds: [echo said]\n')
    const states = async (options: Record<string, unknown>) => {
      const messages = await run({ ...base, tasks: ['say'], options, entry: join(directory, '.hammerkit.yaml') })
      expect(messages[messages.length - 1]).toEqual({ kind: 'result', ok: true })
      return messages.flatMap((m) => (m.kind === 'event' && m.event.type === 'task' ? [m.event.state] : []))
    }
    // what a run without arguments caches, a run with them does not take, nor store
    expect(await states({})).toContain('succeeded')
    expect(await states({})).toEqual(['cached'])
    expect(await states({ args: ['x'] })).toContain('succeeded')
    expect(await states({ args: ['x'] })).toContain('succeeded')
    // a method named in the run keeps the caching
    expect(await states({ args: ['y'], cache: 'checksum' })).toContain('succeeded')
    expect(await states({ args: ['y'], cache: 'checksum' })).toEqual(['cached'])
  })

  it('holds the run to the network ceiling of the server', async () => {
    // a local task can not be limited, so the ceiling refuses it before it starts
    const messages = await run({ ...base, network: 'none', entry: join(directory, '.hammerkit.yaml') })
    expect(messages[messages.length - 1]).toEqual({
      kind: 'result',
      ok: false,
      error: expect.stringContaining("can't limit the network of the local task hello"),
    })
    expect(messages.some((m) => m.kind === 'event' && m.event.type === 'task')).toBe(false)
  })

  it('holds a run on a sandbox to the lower of the two ceilings, combined in the process', async () => {
    const messages = await run({
      ...base,
      network: 'open',
      sandboxNetwork: 'none',
      entry: join(directory, '.hammerkit.yaml'),
    })
    expect(messages[messages.length - 1]).toEqual({
      kind: 'result',
      ok: false,
      error: expect.stringContaining('--network none needs every task in a container'),
    })
    const runs: NetworkSchema = { allow: ['*.corp.com', 'registry.npmjs.org'] }
    const sandbox: NetworkSchema = { allow: ['vault.corp.com:8200', '*.npmjs.org'] }
    expect(getRunNetwork({ network: runs })).toEqual(parseWorkNetwork(runs))
    expect(getRunNetwork({ sandboxNetwork: sandbox })).toEqual(parseWorkNetwork(sandbox))
    // the combination itself, with whatever it marks, not a build file's `network` written from it
    const combined = getRunNetwork({ network: runs, sandboxNetwork: sandbox })
    expect(combined).toEqual(limitNetwork(parseWorkNetwork(sandbox), parseWorkNetwork(runs)))
    expect(combined).toMatchObject({ type: 'allow', hosts: ['registry.npmjs.org', 'vault.corp.com:8200'] })
  })

  it('says when the build file has no such task', async () => {
    const messages = await run({ ...base, tasks: ['nope'], entry: join(directory, '.hammerkit.yaml') })
    expect(messages[messages.length - 1]).toMatchObject({ kind: 'result', ok: false })
  })
})

describe('taskCauses', () => {
  it('names at most 20 causes of a cache miss, masked and cut short', () => {
    const causes = Array.from({ length: 25 }, (_, i) => `src/file-${i}.txt changed, token secret-${i}`)
    causes[0] = 'x'.repeat(5000)
    const result = taskCauses(causes, (text) => text.replace(/secret-\d+/g, '***'))
    expect(result.causes).toHaveLength(21)
    expect(result.causes?.[0]).toHaveLength(2048)
    expect(result.causes?.[1]).toBe('src/file-1.txt changed, token ***')
    expect(result.causes?.[20]).toBe('… and 5 more')
  })

  it('leaves the causes out when there are none', () => {
    expect(taskCauses(undefined, (text) => text)).toEqual({})
    expect(taskCauses([], (text) => text)).toEqual({})
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
