import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { runProgram } from '../run-program'
import { createCli } from '../program'
import { Environment } from '../executer/environment'
import { memoryStream } from '../testing/test-streams'

// `cache pull` / `cache push` move entries between a task's own (local) cache
// and a named remote cache without executing anything (ADR-0001). Both ends are
// `local` backends in the test directory so every transfer is observable; the
// remote is selected by name exactly as an s3/registry remote would be.

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so gate the real runs off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

const tempRoot = join(process.cwd(), 'temp')

function project(localCache: string, remoteCache: string) {
  return {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      caches: {
        default: { method: 'checksum', backend: { type: 'local', path: localCache } },
        shared: { method: 'checksum', backend: { type: 'local', path: remoteCache } },
      },
      tasks: {
        base: {
          labels: { app: 'web' },
          src: ['base.txt'],
          generates: ['base-out'],
          cmds: ['mkdir -p base-out', 'cp base.txt base-out/base.txt'],
        },
        build: {
          labels: { app: 'web' },
          deps: ['base'],
          src: ['input.txt'],
          generates: ['out'],
          cmds: ['mkdir -p out', 'cp input.txt out/result.txt', 'date >> executions.log'],
        },
        other: {
          labels: { app: 'api' },
          src: ['input.txt'],
          generates: ['other-out'],
          cmds: ['mkdir -p other-out', 'cp input.txt other-out/other.txt'],
        },
      },
    },
    'input.txt': 'hello\n',
    'base.txt': 'base\n',
  }
}

async function entries(environment: Environment, path: string): Promise<number> {
  if (!(await environment.file.exists(path))) {
    return 0
  }
  return (await environment.file.listFiles(path)).length
}

async function hammerkit(environment: Environment, args: string[]): Promise<string> {
  const out = memoryStream()
  environment.stdout = out.stream
  await runProgram(environment, ['hammerkit', ...args], true)
  return out.read()
}

describe('cache pull / push', () => {
  itExceptWindows('pushes locally produced entries to the remote without executing, idempotently', async () => {
    const localCache = join(tempRoot, 'cache-sync-push-local')
    const remoteCache = join(tempRoot, 'cache-sync-push-remote')
    await createTestCase('cache-sync-push', project(localCache, remoteCache)).setup(async (cwd, environment) => {
      await environment.file.remove(localCache)
      await environment.file.remove(remoteCache)

      await hammerkit(environment, ['run', 'build', '--no-summary'])
      expect(await entries(environment, localCache)).toBe(2) // base + build
      expect(await entries(environment, remoteCache)).toBe(0)
      await environment.file.remove(join(cwd, 'executions.log'))

      const output = await hammerkit(environment, ['cache', 'push', 'build', '--remote', 'shared'])
      expect(output).toContain('build: pushed')
      expect(output).toContain('base: pushed')
      expect(await entries(environment, remoteCache)).toBe(2)
      // nothing executed
      expect(await environment.file.exists(join(cwd, 'executions.log'))).toBe(false)

      const again = await hammerkit(environment, ['cache', 'push', 'build', '--remote', 'shared'])
      expect(again).toContain('build: already present')
    })
  })

  itExceptWindows('pushes outputs that are current in the checkout even without a local cache entry', async () => {
    const localCache = join(tempRoot, 'cache-sync-current-local')
    const remoteCache = join(tempRoot, 'cache-sync-current-remote')
    await createTestCase('cache-sync-current', project(localCache, remoteCache)).setup(async (cwd, environment) => {
      await environment.file.remove(localCache)
      await environment.file.remove(remoteCache)
      await hammerkit(environment, ['run', 'build', '--no-summary'])
      // e.g. a sandbox whose machine cache was discarded, or outputs that were
      // restored by the runtime's own state rather than from a backend
      await environment.file.remove(localCache)

      const output = await hammerkit(environment, ['cache', 'push', 'build', '--remote', 'shared'])
      expect(output).toContain('build: pushed')
      expect(output).toContain('base: pushed')
      expect(await entries(environment, remoteCache)).toBe(2)
    })
  })

  itExceptWindows('reports a task whose outputs are stale and uncached as missing on push', async () => {
    const localCache = join(tempRoot, 'cache-sync-stale-local')
    const remoteCache = join(tempRoot, 'cache-sync-stale-remote')
    await createTestCase('cache-sync-stale', project(localCache, remoteCache)).setup(async (cwd, environment) => {
      await environment.file.remove(localCache)
      await environment.file.remove(remoteCache)
      await hammerkit(environment, ['run', 'build', '--no-summary'])
      await environment.file.remove(localCache)
      await environment.file.writeFile(join(cwd, 'input.txt'), 'changed\n')

      const output = await hammerkit(environment, ['cache', 'push', 'build', '--remote', 'shared'])
      expect(output).toContain('build: not in local cache')
      expect(await entries(environment, remoteCache)).toBe(1) // only the unchanged base
    })
  })

  itExceptWindows('pulls into the local cache so a later build restores without executing', async () => {
    const remoteCache = join(tempRoot, 'cache-sync-pull-remote')

    // "CI": build and push to the shared remote
    const writerCache = join(tempRoot, 'cache-sync-pull-writer-local')
    await createTestCase('cache-sync-pull-writer', project(writerCache, remoteCache)).setup(
      async (cwd, environment) => {
        await environment.file.remove(writerCache)
        await environment.file.remove(remoteCache)
        await hammerkit(environment, ['run', 'build', '--no-summary'])
        await hammerkit(environment, ['cache', 'push', 'build', '--remote', 'shared'])
      }
    )

    // "agent workspace": another checkout with an empty machine cache
    const readerCache = join(tempRoot, 'cache-sync-pull-reader-local')
    await createTestCase('cache-sync-pull-reader', project(readerCache, remoteCache)).setup(
      async (cwd, environment) => {
        await environment.file.remove(readerCache)

        const output = await hammerkit(environment, ['cache', 'pull', 'build', '--remote', 'shared'])
        expect(output).toContain('build: pulled')
        expect(output).toContain('base: pulled')
        expect(await entries(environment, readerCache)).toBe(2)
        expect(await environment.file.exists(join(cwd, 'out'))).toBe(false) // pull only warms the cache

        // the remote is gone: the build must be served from the warmed local cache
        await environment.file.remove(remoteCache)
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
        const result = await cli.runExec()
        expect(result.success).toBe(true)
        expect(result.state.tasks['build'].state.current).toMatchObject({ type: 'completed', cached: true })
        expect(await environment.file.read(join(cwd, 'out', 'result.txt'))).toBe('hello\n')
        expect(await environment.file.exists(join(cwd, 'executions.log'))).toBe(false)
      }
    )
  })

  itExceptWindows('skips entries absent on the remote and still succeeds', async () => {
    const localCache = join(tempRoot, 'cache-sync-missing-local')
    const remoteCache = join(tempRoot, 'cache-sync-missing-remote')
    await createTestCase('cache-sync-missing', project(localCache, remoteCache)).setup(async (cwd, environment) => {
      await environment.file.remove(localCache)
      await environment.file.remove(remoteCache)
      const output = await hammerkit(environment, ['cache', 'pull', 'build', '--remote', 'shared'])
      expect(output).toContain('build: not in remote')
      expect(await entries(environment, localCache)).toBe(0)
    })
  })

  itExceptWindows('limits the transfer to the label scope plus its dependencies', async () => {
    const localCache = join(tempRoot, 'cache-sync-scope-local')
    const remoteCache = join(tempRoot, 'cache-sync-scope-remote')
    await createTestCase('cache-sync-scope', project(localCache, remoteCache)).setup(async (cwd, environment) => {
      await environment.file.remove(localCache)
      await environment.file.remove(remoteCache)
      await hammerkit(environment, ['run', '--no-summary'])
      expect(await entries(environment, localCache)).toBe(3)

      await hammerkit(environment, ['cache', 'push', '--remote', 'shared', '--filter', 'app=api'])
      expect(await entries(environment, remoteCache)).toBe(1)
    })
  })

  it('refuses to push in read-only mode', async () => {
    const localCache = join(tempRoot, 'cache-sync-ro-local')
    const remoteCache = join(tempRoot, 'cache-sync-ro-remote')
    await createTestCase('cache-sync-ro', project(localCache, remoteCache)).setup(async (cwd, environment) => {
      environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_CACHE_READ_ONLY: '1' }
      await expect(hammerkit(environment, ['cache', 'push', '--remote', 'shared'])).rejects.toThrow(/read-only/)
    })
  })

  it('fails with a clear error for an unknown remote', async () => {
    const localCache = join(tempRoot, 'cache-sync-unknown-local')
    const remoteCache = join(tempRoot, 'cache-sync-unknown-remote')
    await createTestCase('cache-sync-unknown', project(localCache, remoteCache)).setup(async (cwd, environment) => {
      await expect(hammerkit(environment, ['cache', 'pull', '--remote', 'nope'])).rejects.toThrow(/nope/)
    })
  })

  it('fails the command when the remote is unreachable', async () => {
    const localCache = join(tempRoot, 'cache-sync-down-local')
    await createTestCase('cache-sync-down', {
      ...project(localCache, join(tempRoot, 'unused')),
      '.hammerkit.yaml': {
        caches: {
          default: { method: 'checksum', backend: { type: 'local', path: localCache } },
          shared: {
            method: 'checksum',
            backend: { type: 's3', bucket: 'cache', region: 'us-east-1', endpoint: 'http://127.0.0.1:1' },
          },
        },
        tasks: { build: { src: ['input.txt'], cmds: ['echo build'] } },
      },
    }).setup(async (cwd, environment) => {
      await environment.file.remove(localCache)
      environment.processEnvs = {
        ...environment.processEnvs,
        AWS_ACCESS_KEY_ID: 'test',
        AWS_SECRET_ACCESS_KEY: 'test',
        AWS_MAX_ATTEMPTS: '1',
      }
      await expect(hammerkit(environment, ['cache', 'pull', '--remote', 'shared'])).rejects.toThrow()
    })
  })
})
