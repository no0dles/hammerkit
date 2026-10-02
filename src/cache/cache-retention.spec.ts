import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { runProgram } from '../run-program'
import { Environment } from '../executer/environment'
import { memoryStream } from '../testing/test-streams'

// `cache ls` / `cache prune` and automatic retention, end-to-end through the CLI
// against `local` backends in the test directory.

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so gate the real runs off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

const tempRoot = join(process.cwd(), 'temp')

function project(localCache: string, retention?: { [key: string]: unknown }) {
  return {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      caches: {
        default: {
          method: 'checksum',
          backend: { type: 'local', path: localCache },
          ...(retention ? { retention } : {}),
        },
      },
      tasks: {
        build: { src: ['input.txt'], generates: ['out'], cmds: ['mkdir -p out', 'cp input.txt out/'] },
        lint: { src: ['lint.txt'], cmds: ['echo lint'] },
      },
    },
    'input.txt': 'v1\n',
    'lint.txt': 'x\n',
  }
}

async function hammerkit(environment: Environment, args: string[]): Promise<string> {
  const out = memoryStream()
  environment.stdout = out.stream
  await runProgram(environment, ['hammerkit', ...args], true)
  return out.read()
}

async function entriesPerTask(environment: Environment): Promise<{ [task: string]: number }> {
  const listed = JSON.parse(await hammerkit(environment, ['cache', 'ls', '--json']))
  const counts: { [task: string]: number } = {}
  for (const entry of listed) {
    counts[entry.taskName] = (counts[entry.taskName] ?? 0) + 1
  }
  return counts
}

// two versions of build (input changed in between), one of lint
async function twoBuildVersions(environment: Environment, cwd: string): Promise<void> {
  await hammerkit(environment, ['run', '--no-summary'])
  await environment.file.writeFile(join(cwd, 'input.txt'), 'v2\n')
  await hammerkit(environment, ['run', '--no-summary'])
}

describe('cache retention', () => {
  itExceptWindows('lists entries per task with sizes', async () => {
    const localCache = join(tempRoot, 'retention-ls-local')
    await createTestCase('retention-ls', project(localCache)).setup(async (cwd, environment) => {
      await environment.file.remove(localCache)
      await twoBuildVersions(environment, cwd)
      expect(await entriesPerTask(environment)).toEqual({ build: 2, lint: 1 })

      const human = await hammerkit(environment, ['cache', 'ls'])
      expect(human).toContain('• build')
      expect(human).toMatch(/3 entries, .* total/)
    })
  })

  itExceptWindows('prunes to the newest version per task with --keep', async () => {
    const localCache = join(tempRoot, 'retention-keep-local')
    await createTestCase('retention-keep', project(localCache)).setup(async (cwd, environment) => {
      await environment.file.remove(localCache)
      await twoBuildVersions(environment, cwd)

      const dryRun = await hammerkit(environment, ['cache', 'prune', '--keep', '1', '--dry-run'])
      expect(dryRun).toContain('would remove 1 entry')
      expect(await entriesPerTask(environment)).toEqual({ build: 2, lint: 1 })

      const output = await hammerkit(environment, ['cache', 'prune', '--keep', '1'])
      expect(output).toContain('removed 1 entry')
      expect(await entriesPerTask(environment)).toEqual({ build: 1, lint: 1 })

      // the kept entry is the current one: the next run is still a cache hit
      const summary = JSON.parse(await hammerkit(environment, ['run', 'build', '--summary-json']))
      expect(summary.tasks[0].status).toBe('cached')
    })
  })

  itExceptWindows('prunes by size, least recently used first', async () => {
    const localCache = join(tempRoot, 'retention-size-local')
    await createTestCase('retention-size', project(localCache)).setup(async (cwd, environment) => {
      await environment.file.remove(localCache)
      await twoBuildVersions(environment, cwd)
      await hammerkit(environment, ['cache', 'prune', '--max-size', '1'])
      expect(await entriesPerTask(environment)).toEqual({})
    })
  })

  itExceptWindows('applies a declared retention policy automatically after a run', async () => {
    const localCache = join(tempRoot, 'retention-auto-local')
    await createTestCase('retention-auto', project(localCache, { keepPerTask: 1 })).setup(async (cwd, environment) => {
      await environment.file.remove(localCache)
      await twoBuildVersions(environment, cwd)
      expect(await entriesPerTask(environment)).toEqual({ build: 1, lint: 1 })
    })
  })

  it('refuses to prune without a policy', async () => {
    const localCache = join(tempRoot, 'retention-none-local')
    await createTestCase('retention-none', project(localCache)).setup(async (cwd, environment) => {
      await expect(hammerkit(environment, ['cache', 'prune'])).rejects.toThrow(/retention policy/)
    })
  })

  it('rejects an invalid retention size', async () => {
    const localCache = join(tempRoot, 'retention-invalid-local')
    await createTestCase('retention-invalid', project(localCache, { maxSize: 'lots' })).setup(
      async (cwd, environment) => {
        await expect(hammerkit(environment, ['cache', 'ls'])).rejects.toThrow()
      }
    )
  })
})
