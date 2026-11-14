import { join } from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { runProgram } from '../run-program'
import { createCli } from '../program'
import { Environment } from '../executer/environment'
import { memoryStream } from '../testing/test-streams'

// `run --no-restore`: a CI check that only wants to know a task passed looks
// its hit up in the cache without downloading the outputs. Outputs come down
// only for a task that runs and depends on them.

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so real runs are gated off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

const tempRoot = join(process.cwd(), 'temp')

function project(sharedCache: string) {
  return {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      caches: { default: { method: 'checksum', backend: { type: 'local', path: sharedCache } } },
      tasks: {
        build: {
          src: ['src'],
          generates: ['dist'],
          cmds: ['echo build >> runs.log', 'mkdir -p dist', 'cat src/a.ts > dist/app.js'],
        },
        e2e: {
          deps: ['build'],
          src: ['e2e', 'dist'],
          generates: ['report'],
          cmds: ['echo e2e >> runs.log', 'mkdir -p report', 'cat dist/app.js e2e/spec.ts > report/result.txt'],
        },
        ci: { deps: ['e2e'] },
      },
    },
    'src/a.ts': 'a\n',
    'e2e/spec.ts': 'spec\n',
  }
}

async function summaryOf(environment: Environment, args: string[]): Promise<{ [task: string]: string }> {
  const out = memoryStream()
  environment.stdout = out.stream
  await runProgram(environment, ['hammerkit', 'run', ...args, '--summary-json'], true)
  const summary = JSON.parse(out.read())
  return Object.fromEntries(summary.tasks.map((t: { taskName: string; status: string }) => [t.taskName, t.status]))
}

async function seed(shared: string, name: string) {
  await createTestCase(name, project(shared)).setup(async (cwd, environment) => {
    await environment.file.remove(shared)
    expect(await summaryOf(environment, ['e2e'])).toEqual({ build: 'executed', e2e: 'executed' })
  })
}

describe('run --no-restore', () => {
  itExceptWindows('reports a hit without downloading its outputs', async () => {
    const shared = join(tempRoot, 'no-restore-hit-shared')
    await seed(shared, 'no-restore-hit-seed')
    await createTestCase('no-restore-hit/checkout', project(shared)).setup(async (cwd, environment) => {
      expect(await summaryOf(environment, ['e2e', '--no-restore'])).toEqual({
        build: 'skipped',
        e2e: 'cached',
      })
      expect(existsSync(join(cwd, 'runs.log'))).toBe(false)
      expect(existsSync(join(cwd, 'report'))).toBe(false)
      expect(existsSync(join(cwd, 'dist'))).toBe(false)
    })
  })

  itExceptWindows('restores nothing for a group whose tasks are all hits', async () => {
    const shared = join(tempRoot, 'no-restore-group-shared')
    await seed(shared, 'no-restore-group-seed')
    await createTestCase('no-restore-group/checkout', project(shared)).setup(async (cwd, environment) => {
      const summary = await summaryOf(environment, ['ci', '--no-restore'])
      expect(summary.e2e).toBe('cached')
      expect(summary.build).not.toBe('executed')
      expect(existsSync(join(cwd, 'runs.log'))).toBe(false)
      expect(existsSync(join(cwd, 'report'))).toBe(false)
      expect(existsSync(join(cwd, 'dist'))).toBe(false)
    })
  })

  itExceptWindows('restores a hit that a task which runs depends on', async () => {
    const shared = join(tempRoot, 'no-restore-dep-shared')
    await seed(shared, 'no-restore-dep-seed')
    await createTestCase('no-restore-dep/checkout', project(shared)).setup(async (cwd, environment) => {
      writeFileSync(join(cwd, 'e2e/spec.ts'), 'changed\n')
      expect(await summaryOf(environment, ['e2e', '--no-restore'])).toEqual({
        build: 'cached',
        e2e: 'executed',
      })
      expect(readFileSync(join(cwd, 'runs.log'), 'utf8')).toBe('e2e\n')
      expect(readFileSync(join(cwd, 'report/result.txt'), 'utf8')).toBe('a\nchanged\n')
    })
  })

  // a Cli runs its work tree again with the same items: a hit deferred in the
  // first run must not be restored over what the second run built
  itExceptWindows('never restores a hit deferred in an earlier run of the same Cli', async () => {
    const shared = join(tempRoot, 'no-restore-rerun-shared')
    await seed(shared, 'no-restore-rerun-seed')
    await createTestCase('no-restore-rerun/checkout', project(shared)).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'e2e' })
      expect((await cli.runExec({ restore: false, skipDeps: false })).success).toBe(true)
      writeFileSync(join(cwd, 'src/a.ts'), 'b\n')
      expect((await cli.runExec({ restore: true })).success).toBe(true)
      expect(readFileSync(join(cwd, 'dist/app.js'), 'utf8')).toBe('b\n')
      expect(readFileSync(join(cwd, 'report/result.txt'), 'utf8')).toBe('b\nspec\n')
    })
  })

  itExceptWindows('still restores a hit by default', async () => {
    const shared = join(tempRoot, 'no-restore-default-shared')
    await seed(shared, 'no-restore-default-seed')
    await createTestCase('no-restore-default/checkout', project(shared)).setup(async (cwd, environment) => {
      expect((await summaryOf(environment, ['e2e'])).e2e).toBe('cached')
      expect(readFileSync(join(cwd, 'report/result.txt'), 'utf8')).toBe('a\nspec\n')
    })
  })
})
