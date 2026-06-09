import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Cli } from '../cli'
import { Environment } from '../executer/environment'
import { computeStateKey } from '../executer/scheduler/state-key'
import { writeLastResolvedRecord, getLastResolvedFile } from './last-resolved'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'
import { ExplainCause, TaskExplanation } from './explain'
import { memoryStream } from '../testing/test-streams'
import { statusConsole } from '../planner/work-item-status'
import { runProgram } from '../run-program'

// Exercises the cache-explain engine end-to-end against a real parsed work tree.
// Rather than spawning a process (local-task execution is mocked elsewhere and is
// not cross-platform), a "run" is simulated by writing exactly what a successful
// run writes: the local runtime state file (so currentStateKey matches) and the
// per-task-name last-resolved record. This keeps the test fast, deterministic and
// runnable in the Windows unit job while still driving the production engine.
async function simulateRun(cli: Cli, environment: Environment, taskName: string): Promise<void> {
  const item = cli.task(taskName)
  const { stateKey, stats } = await computeStateKey(item, 'checksum', environment)
  await environment.file.createDirectory(join(item.data.cwd, '.hammerkit'))
  await environment.file.writeFile(join(item.data.cwd, '.hammerkit', item.id()), stateKey)
  await writeLastResolvedRecord(environment, item, {
    description: getWorkTaskCacheDescription(item.data),
    stats,
  })
}

function explanationFor(explanations: TaskExplanation[], name: string): TaskExplanation {
  const found = explanations.find((e) => e.taskName === name)
  if (!found) {
    throw new Error(`no explanation for ${name}: ${explanations.map((e) => e.taskName).join(', ')}`)
  }
  return found
}

function hasCause(explanation: TaskExplanation, cause: ExplainCause): boolean {
  return explanation.causes.some((c) => c.kind === cause.kind && c.identifier === cause.identifier)
}

describe('cache explain (fast)', () => {
  it('reports a cached task as a hit, then names the changed file as a miss (SC-001, SC-002)', async () => {
    const t = createTestCase('explain-source', {
      '.hammerkit.yaml': { tasks: { build: { cmds: ['node --version'], src: ['input.txt'] } } },
      'input.txt': 'one\n',
    })
    await t.setup(async (cwd, environment) => {
      const fileName = join(cwd, '.hammerkit.yaml')
      const cli = await createCli(fileName, environment, { taskName: 'build' })
      await cli.clean({ cache: true })

      await simulateRun(cli, environment, 'build')
      const hit = explanationFor(await cli.explain(), 'build')
      expect(hit.status).toBe('hit')
      expect(hit.causes).toHaveLength(0)

      // the last-resolved record is persisted (FR-004 / AC5)
      expect(await environment.file.exists(getLastResolvedFile(cli.task('build')))).toBe(true)

      await environment.file.writeFile(join(cwd, 'input.txt'), 'two\n')
      const miss = explanationFor(await cli.explain(), 'build')
      expect(miss.status).toBe('miss')
      expect(hasCause(miss, { kind: 'source-changed', identifier: 'input.txt' })).toBe(true)
    })
  })

  it('reports a never-run task as never cached, not an error (SC-003)', async () => {
    const t = createTestCase('explain-never', {
      '.hammerkit.yaml': { tasks: { build: { cmds: ['node --version'], src: ['input.txt'] } } },
      'input.txt': 'x\n',
    })
    await t.setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      await cli.clean({ cache: true })

      const build = explanationFor(await cli.explain(), 'build')
      expect(build.status).toBe('miss')
      expect(hasCause(build, { kind: 'never-cached' })).toBe(true)
    })
  })

  it('reports a task with no src as uncacheable with cause "no src declared"', async () => {
    const t = createTestCase('explain-no-src', {
      '.hammerkit.yaml': { tasks: { build: { cmds: ['node --version'] } } },
    })
    await t.setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      await cli.clean({ cache: true })

      const build = explanationFor(await cli.explain(), 'build')
      expect(build.status).toBe('uncacheable')
      expect(hasCause(build, { kind: 'no-src' })).toBe(true)
    })
  })

  it('attributes a downstream miss to the changed dependency, not its own sources (SC-004)', async () => {
    const t = createTestCase('explain-dependency', {
      '.hammerkit.yaml': {
        tasks: {
          lib: { cmds: ['node --version'], src: ['lib.txt'] },
          app: { cmds: ['node --version'], src: ['app.txt'], deps: ['lib'] },
        },
      },
      'lib.txt': 'lib\n',
      'app.txt': 'app\n',
    })
    await t.setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'app' })
      await cli.clean({ cache: true })

      await simulateRun(cli, environment, 'lib')
      await simulateRun(cli, environment, 'app')
      expect(explanationFor(await cli.explain(), 'app').status).toBe('hit')

      // only the upstream dependency's source changes
      await environment.file.writeFile(join(cwd, 'lib.txt'), 'lib changed\n')
      const explanations = await cli.explain()

      const app = explanationFor(explanations, 'app')
      expect(app.status).toBe('miss')
      expect(hasCause(app, { kind: 'dependency-changed', identifier: 'lib' })).toBe(true)
      // the downstream cause is the dependency, NOT its own (unchanged) source
      expect(hasCause(app, { kind: 'source-changed', identifier: 'app.txt' })).toBe(false)

      const lib = explanationFor(explanations, 'lib')
      expect(hasCause(lib, { kind: 'source-changed', identifier: 'lib.txt' })).toBe(true)
    })
  })

  it('reports every changed input, not just the first (AC: multiple causes)', async () => {
    const t = createTestCase('explain-multiple', {
      '.hammerkit.yaml': {
        tasks: { build: { cmds: ['node --version'], src: ['a.txt', 'b.txt'], envs: { TOKEN: 'one' } } },
      },
      'a.txt': 'a\n',
      'b.txt': 'b\n',
    })
    await t.setup(async (cwd, environment) => {
      const fileName = join(cwd, '.hammerkit.yaml')
      const cli = await createCli(fileName, environment, { taskName: 'build' })
      await cli.clean({ cache: true })
      await simulateRun(cli, environment, 'build')

      await environment.file.writeFile(join(cwd, 'a.txt'), 'a changed\n')
      await environment.file.writeFile(join(cwd, 'b.txt'), 'b changed\n')
      const build = explanationFor(await cli.explain(), 'build')
      expect(build.status).toBe('miss')
      expect(hasCause(build, { kind: 'source-changed', identifier: 'a.txt' })).toBe(true)
      expect(hasCause(build, { kind: 'source-changed', identifier: 'b.txt' })).toBe(true)
    })
  })

  it('names a changed environment variable as the cause', async () => {
    const t = createTestCase('explain-env', {
      '.hammerkit.yaml': {
        tasks: { build: { cmds: ['node --version'], src: ['input.txt'], envs: { TOKEN: 'one' } } },
      },
      'input.txt': 'x\n',
    })
    await t.setup(async (cwd, environment) => {
      const fileName = join(cwd, '.hammerkit.yaml')
      const cli = await createCli(fileName, environment, { taskName: 'build' })
      await cli.clean({ cache: true })
      await simulateRun(cli, environment, 'build')

      // a different env value means a different task *id*; the name-keyed record
      // still lets explain diff against the previous run (FR-004).
      await environment.file.writeFile(
        fileName,
        'tasks:\n  build:\n    cmds:\n      - node --version\n    src:\n      - input.txt\n    envs:\n      TOKEN: two\n'
      )
      const cli2 = await createCli(fileName, environment, { taskName: 'build' })
      const build = explanationFor(await cli2.explain(), 'build')
      expect(build.status).toBe('miss')
      expect(hasCause(build, { kind: 'env-changed', identifier: 'TOKEN' })).toBe(true)
    })
  })

  it('explain --json emits valid JSON with each task status (US3 FR-006)', async () => {
    const t = createTestCase('explain-json', {
      '.hammerkit.yaml': { tasks: { build: { cmds: ['true'], src: ['input.txt'] } } },
      'input.txt': 'x\n',
    })
    await t.setup(async (cwd, environment) => {
      const out = memoryStream()
      environment.stdout = out.stream
      await runProgram(environment, ['hammerkit', 'explain', '--json'], true)
      const parsed = JSON.parse(out.read())
      expect(Array.isArray(parsed)).toBe(true)
      const build = parsed.find((e: TaskExplanation) => e.taskName === 'build')
      expect(build.status).toBe('miss')
      expect(build.causes.some((c: ExplainCause) => c.kind === 'never-cached')).toBe(true)
    })
  })

  // Inline miss-reason needs a real run; local execution is gated off win32.
  const itExceptWindows = process.platform === 'win32' ? it.skip : it

  itExceptWindows('run --explain prints the miss cause for a rebuild and nothing for a hit (US2 FR-005)', async () => {
    const t = createTestCase('explain-inline', {
      '.hammerkit.yaml': { tasks: { greet: { cmds: ['node --version'], src: ['input.txt'] } } },
      'input.txt': 'x\n',
    })
    await t.setup(async (cwd, environment) => {
      const fileName = join(cwd, '.hammerkit.yaml')
      const cli = await createCli(fileName, environment, {})
      await cli.clean({ cache: true })

      // first run: never cached → the miss cause is reported inline
      const status1 = memoryStream()
      environment.status = statusConsole(status1.stream)
      await runProgram(environment, ['hammerkit', 'run', '--explain'], true)
      expect(status1.read()).toContain('cache miss')

      // second run: now a cache hit → no miss reason
      const status2 = memoryStream()
      environment.status = statusConsole(status2.stream)
      await runProgram(environment, ['hammerkit', 'run', '--explain'], true)
      expect(status2.read()).not.toContain('cache miss')
    })
  })
})
