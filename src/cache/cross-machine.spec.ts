import { join } from 'path'
import { existsSync, readdirSync, readFileSync, statSync } from 'fs'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { runProgram } from '../run-program'
import { Environment } from '../executer/environment'
import { memoryStream } from '../testing/test-streams'
import { computeStateKey } from '../executer/scheduler/state-key'

// The agent → shared cache → CI flow: what one checkout builds and pushes, a
// clean checkout on another machine reuses without executing anything. Another
// machine means another path, and a filesystem that lists directories in its
// own order (ext4 and overlayfs return hash order, APFS does not).

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
          cmds: ['echo build >> runs.log', 'mkdir -p dist', 'cat src/a.ts src/b.ts src/c.ts > dist/app.js'],
        },
        e2e: {
          deps: ['build'],
          src: ['e2e', 'dist'],
          generates: ['report'],
          cmds: ['echo e2e >> runs.log', 'mkdir -p report', 'cat dist/app.js e2e/spec.ts > report/result.txt'],
        },
      },
    },
    'src/a.ts': 'a\n',
    'src/b.ts': 'b\n',
    'src/c.ts': 'c\n',
    'e2e/spec.ts': 'spec\n',
  }
}

// another machine's filesystem: same entries, another listing order
function otherMachine(environment: Environment): void {
  const listFiles = environment.file.listFiles.bind(environment.file)
  environment.file = { ...environment.file, listFiles: async (path) => (await listFiles(path)).reverse() }
}

async function summaryOf(environment: Environment, args: string[]): Promise<{ [task: string]: string }> {
  const out = memoryStream()
  environment.stdout = out.stream
  await runProgram(environment, ['hammerkit', 'run', ...args, '--summary-json'], true)
  const summary = JSON.parse(out.read())
  return Object.fromEntries(summary.tasks.map((t: { taskName: string; status: string }) => [t.taskName, t.status]))
}

describe('cache across machines', () => {
  it('computes the same state key whatever order the filesystem lists files in', async () => {
    const keys: string[] = []
    for (const [name, reorder] of [
      ['cross-machine-order-a', false],
      ['cross-machine-order-b/elsewhere', true],
    ] as const) {
      await createTestCase(name, project(join(tempRoot, 'cross-machine-order-shared'))).setup(
        async (cwd, environment) => {
          if (reorder) {
            otherMachine(environment)
          }
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
          keys.push((await computeStateKey(cli.task('build'), 'checksum', environment)).stateKey)
        }
      )
    }
    expect(keys[1]).toBe(keys[0])
  })

  itExceptWindows('reuses in a clean checkout elsewhere what another checkout built, running nothing', async () => {
    const shared = join(tempRoot, 'cross-machine-flow-shared')
    // "agent": builds and tests, pushing both entries to the shared cache
    await createTestCase('cross-machine-flow-agent', project(shared)).setup(async (cwd, environment) => {
      await environment.file.remove(shared)
      expect(await summaryOf(environment, ['e2e'])).toEqual({ build: 'executed', e2e: 'executed' })
    })
    // "CI": a clean checkout at another path, on another filesystem
    await createTestCase('cross-machine-flow-ci/checkout', project(shared)).setup(async (cwd, environment) => {
      otherMachine(environment)
      expect(await summaryOf(environment, ['e2e'])).toEqual({ build: 'skipped', e2e: 'cached' })
      expect(existsSync(join(cwd, 'runs.log'))).toBe(false)
      expect(readFileSync(join(cwd, 'report/result.txt'), 'utf8')).toBe('a\nb\nc\nspec\n')
    })
  })

  // A shared cache is readable by everyone who can pull from it, so the entry
  // metadata carries a digest of each env value, never the value (a token passed
  // as an env is still part of the task id).
  itExceptWindows('never writes env values into cache entries or local metadata', async () => {
    const shared = join(tempRoot, 'cross-machine-env-shared')
    const secret = 'tok-1f3a9c77e2b4'
    await createTestCase('cross-machine-env', {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': {
        caches: { default: { method: 'checksum', backend: { type: 'local', path: shared } } },
        tasks: {
          build: { src: ['in.txt'], envs: { NPM_TOKEN: secret }, generates: ['out.txt'], cmds: ['cp in.txt out.txt'] },
        },
      },
      'in.txt': 'in\n',
    }).setup(async (cwd, environment) => {
      await environment.file.remove(shared)
      expect(await summaryOf(environment, ['build'])).toEqual({ build: 'executed' })
      const written = [...filesUnder(shared), ...filesUnder(join(cwd, '.hammerkit'))]
      expect(written.length).toBeGreaterThan(0)
      expect(written.filter((file) => readFileSync(file).includes(secret))).toEqual([])
    })
  })
})

function filesUnder(path: string): string[] {
  if (!existsSync(path)) {
    return []
  }
  if (!statSync(path).isDirectory()) {
    return [path]
  }
  return readdirSync(path).flatMap((entry) => filesUnder(join(path, entry)))
}
