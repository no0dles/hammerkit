import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { runProgram } from '../run-program'
import { Environment } from './environment'
import { memoryStream } from '../testing/test-streams'

// A dependency that was not requested only runs when a task needing it has to
// execute. When every task needing it is a cache hit, it is skipped: a cached
// e2e job does not rebuild the app it was tested against.

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so gate these real runs off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

const tempRoot = join(process.cwd(), 'temp')

function project(sharedCache: string) {
  return {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      caches: { default: { method: 'checksum', backend: { type: 'local', path: sharedCache } } },
      tasks: {
        prepare: { src: ['p.txt'], cmds: ['echo prepare >> runs.log'] },
        build: { deps: ['prepare'], src: ['b.txt'], labels: { stage: 'build' }, cmds: ['echo build >> runs.log'] },
        e2e: { deps: ['build'], src: ['e.txt'], labels: { stage: 'test' }, cmds: ['echo e2e >> runs.log'] },
      },
    },
    'p.txt': 'p\n',
    'b.txt': 'b\n',
    'e.txt': 'e\n',
  }
}

async function runs(environment: Environment, cwd: string): Promise<string[]> {
  const log = join(cwd, 'runs.log')
  if (!(await environment.file.exists(log))) {
    return []
  }
  return (await environment.file.read(log)).trim().split('\n')
}

// "CI": builds everything once and leaves only e2e's result in the shared cache,
// like a CI that pulled only the e2e entry an agent pushed.
async function seedOnlyE2e(sharedCache: string, name: string): Promise<void> {
  await createTestCase(name, project(sharedCache)).setup(async (cwd, environment) => {
    await environment.file.remove(sharedCache)
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'e2e' })
    expect((await cli.runExec()).success).toBe(true)
    await environment.file.remove(join(sharedCache, cli.task('build').id()))
    await environment.file.remove(join(sharedCache, cli.task('prepare').id()))
  })
}

async function summaryOf(environment: Environment, args: string[]): Promise<{ [task: string]: string }> {
  const out = memoryStream()
  environment.stdout = out.stream
  await runProgram(environment, ['hammerkit', 'run', ...args, '--summary-json'], true)
  const summary = JSON.parse(out.read())
  return Object.fromEntries(summary.tasks.map((t: { taskName: string; status: string }) => [t.taskName, t.status]))
}

describe('skipping dependencies of cached tasks', () => {
  itExceptWindows('skips the dependencies of a cached task', async () => {
    const shared = join(tempRoot, 'skip-deps-cached-shared')
    await seedOnlyE2e(shared, 'skip-deps-cached-seed')
    await createTestCase('skip-deps-cached', project(shared)).setup(async (cwd, environment) => {
      expect(await summaryOf(environment, ['e2e'])).toEqual({ e2e: 'cached', build: 'skipped', prepare: 'skipped' })
      expect(await runs(environment, cwd)).toEqual([])
    })
  })

  itExceptWindows('runs every dependency with --no-skip-deps', async () => {
    const shared = join(tempRoot, 'skip-deps-optout-shared')
    await seedOnlyE2e(shared, 'skip-deps-optout-seed')
    await createTestCase('skip-deps-optout', project(shared)).setup(async (cwd, environment) => {
      expect(await summaryOf(environment, ['e2e', '--no-skip-deps'])).toEqual({
        e2e: 'cached',
        build: 'executed',
        prepare: 'executed',
      })
      expect(await runs(environment, cwd)).toEqual(['prepare', 'build'])
    })
  })

  itExceptWindows('runs a dependency when a task needing it misses the cache', async () => {
    const shared = join(tempRoot, 'skip-deps-miss-shared')
    await seedOnlyE2e(shared, 'skip-deps-miss-seed')
    await createTestCase('skip-deps-miss', { ...project(shared), 'e.txt': 'changed\n' }).setup(
      async (cwd, environment) => {
        // e2e changed, so build must run; prepare runs because build does
        expect(await summaryOf(environment, ['e2e'])).toEqual({
          e2e: 'executed',
          build: 'executed',
          prepare: 'executed',
        })
        expect(await runs(environment, cwd)).toEqual(['prepare', 'build', 'e2e'])
      }
    )
  })

  itExceptWindows('always runs requested tasks, even when a task depending on them is cached', async () => {
    const shared = join(tempRoot, 'skip-deps-requested-shared')
    await seedOnlyE2e(shared, 'skip-deps-requested-seed')
    await createTestCase('skip-deps-requested', project(shared)).setup(async (cwd, environment) => {
      // build and e2e are both selected by label; prepare is only a dependency
      expect(await summaryOf(environment, ['-f', 'stage=build', 'stage=test'])).toEqual({
        e2e: 'cached',
        build: 'executed',
        prepare: 'executed',
      })
    })
  })
})
