import { join } from 'path'
import { WorkTree } from '../planner/work-tree'
import { TaskState } from './scheduler/task-state'
import { printRunSummary, summarizeRun } from './run-summary'
import { memoryStream } from '../testing/test-streams'
import { Environment } from './environment'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { runProgram } from '../run-program'

function fakeTask(name: string, current: TaskState) {
  return { id: () => `id-${name}`, name, state: { current } } as any
}

function fakeTree(tasks: Record<string, ReturnType<typeof fakeTask>>): WorkTree {
  return { tasks, services: {}, environment: {} } as any
}

const completed = (cached: boolean, duration: number): TaskState => ({
  type: 'completed',
  cached,
  duration,
  stateKey: 'k',
})

describe('run summary (fast)', () => {
  it('lists each task once with executed/cached counts and the hit ratio (SC-001, SC-003)', () => {
    const summary = summarizeRun(
      fakeTree({
        a: fakeTask('a', completed(true, 1)),
        b: fakeTask('b', completed(true, 1)),
        c: fakeTask('c', completed(true, 1)),
        d: fakeTask('d', completed(false, 200)),
      }),
      500
    )
    expect(summary.tasks.map((t) => t.taskName)).toEqual(['a', 'b', 'c', 'd'])
    expect(summary.executed).toBe(1)
    expect(summary.cached).toBe(3)
    expect(summary.cacheHitRatio).toBeCloseTo(0.75)
  })

  it('distinguishes failed and cancelled (incl. never-started) tasks', () => {
    const summary = summarizeRun(
      fakeTree({
        ok: fakeTask('ok', completed(false, 10)),
        boom: fakeTask('boom', { type: 'error', errorMessage: 'x', stateKey: null }),
        stopped: fakeTask('stopped', { type: 'canceled', stateKey: null }),
        nostart: fakeTask('nostart', { type: 'pending', stateKey: null }),
      }),
      10
    )
    const byName = Object.fromEntries(summary.tasks.map((t) => [t.taskName, t.status]))
    expect(byName).toEqual({ ok: 'executed', boom: 'failed', stopped: 'cancelled', nostart: 'cancelled' })
    expect(summary.failed).toBe(1)
    expect(summary.cancelled).toBe(2)
  })

  it('renders a cached task at near-zero duration and marks failures (SC-002)', () => {
    const out = memoryStream()
    const environment = { stdout: out.stream } as Environment
    printRunSummary(
      environment,
      summarizeRun(
        fakeTree({
          cachedTask: fakeTask('cachedTask', completed(true, 0)),
          brokenTask: fakeTask('brokenTask', { type: 'crash', exitCode: 1, stateKey: 'k' }),
        }),
        42
      )
    )
    const text = out.read()
    expect(text).toContain('cachedTask')
    expect(text).toContain('cached')
    expect(text).toContain('0ms')
    expect(text).toContain('failed')
    expect(text).toContain('42ms total')
  })

  it('reports an empty graph as "nothing ran" rather than crashing', () => {
    const out = memoryStream()
    const environment = { stdout: out.stream } as Environment
    printRunSummary(environment, summarizeRun(fakeTree({}), 0))
    expect(out.read()).toContain('nothing ran')
  })

  it('surfaces the captured cache-miss cause on a rebuilt task and is JSON-serializable (#22)', () => {
    const summary = summarizeRun(
      fakeTree({
        x: fakeTask('x', {
          type: 'completed',
          cached: false,
          duration: 5,
          stateKey: 'k',
          missCauses: ['source changed: a.txt'],
        }),
      }),
      10
    )
    expect(summary.tasks[0].cause).toBe('source changed: a.txt')

    // valid, complete JSON form: per-task fields + aggregates
    const parsed = JSON.parse(JSON.stringify(summary))
    expect(parsed.tasks[0]).toMatchObject({
      taskId: 'id-x',
      status: 'executed',
      duration: 5,
      cause: 'source changed: a.txt',
    })
    expect(parsed).toHaveProperty('executed')
    expect(parsed).toHaveProperty('cached')
    expect(parsed).toHaveProperty('cacheHitRatio')
    expect(parsed).toHaveProperty('totalDuration')

    const out = memoryStream()
    printRunSummary({ stdout: out.stream } as Environment, summary)
    expect(out.read()).toContain('source changed: a.txt')
  })

  // Real-run wiring through the CLI. Local task execution is not reliable on the
  // Windows hosted runner (see execute.spec.ts), so gate it off win32.
  const itExceptWindows = process.platform === 'win32' ? it.skip : it

  itExceptWindows('prints the summary after a run and suppresses it with --no-summary (SC-004)', async () => {
    async function runAndCapture(args: string[]): Promise<string> {
      let captured = ''
      const t = createTestCase(`summary-wiring-${args.includes('--no-summary') ? 'off' : 'on'}`, {
        '.hammerkit.yaml': { tasks: { greet: { cmds: ['node --version'] } } },
      })
      await t.setup(async (cwd, environment) => {
        const out = memoryStream()
        environment.stdout = out.stream
        await runProgram(environment, args, true)
        captured = out.read()
      })
      return captured
    }

    expect(await runAndCapture(['hammerkit', 'run'])).toContain('Summary')
    expect(await runAndCapture(['hammerkit', 'run', '--no-summary'])).not.toContain('Summary')
  })

  itExceptWindows('run --summary-json emits clean, valid JSON with per-task + aggregate fields (#22)', async () => {
    let captured = ''
    const t = createTestCase('summary-json', {
      '.hammerkit.yaml': { tasks: { greet: { cmds: ['node --version'] } } },
    })
    await t.setup(async (cwd, environment) => {
      const out = memoryStream()
      environment.stdout = out.stream
      await runProgram(environment, ['hammerkit', 'run', '--summary-json'], true)
      captured = out.read()
    })
    // the human progress logger is suppressed under --summary-json, so stdout is
    // pure JSON
    const parsed = JSON.parse(captured)
    expect(Array.isArray(parsed.tasks)).toBe(true)
    expect(parsed.tasks.find((task: { taskName: string }) => task.taskName === 'greet').status).toBe('executed')
    expect(parsed).toHaveProperty('cacheHitRatio')
  })

  itExceptWindows('run --explain adds the miss-cause column to the human summary (#22)', async () => {
    let captured = ''
    const t = createTestCase('summary-cause', {
      '.hammerkit.yaml': { tasks: { greet: { cmds: ['node --version'], src: ['input.txt'] } } },
      'input.txt': 'x\n',
    })
    await t.setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      await cli.clean({ cache: true })
      const out = memoryStream()
      environment.stdout = out.stream
      // first run: never cached → the summary shows the cause column
      await runProgram(environment, ['hammerkit', 'run', '--explain'], true)
      captured = out.read()
    })
    expect(captured).toContain('never cached')
  })
})
