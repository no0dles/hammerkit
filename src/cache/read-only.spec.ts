import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { runProgram } from '../run-program'
import { createCli } from '../program'
import { Environment } from '../executer/environment'

// Read-only cache mode: an untrusted runner (an agent sandbox) may restore from
// the shared cache but must never write to it. Exercised end-to-end through the
// CLI against a `local` backend in the test directory, so the backend's contents
// are directly observable.

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so gate these real runs off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

function project(backendPath: string) {
  return {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      caches: { default: { method: 'checksum', backend: { type: 'local', path: backendPath } } },
      tasks: {
        build: { src: ['input.txt'], generates: ['out'], cmds: ['mkdir -p out', 'cp input.txt out/result.txt'] },
      },
    },
    'input.txt': 'hello\n',
  }
}

async function backendEntries(environment: Environment, backendPath: string): Promise<string[]> {
  if (!(await environment.file.exists(backendPath))) {
    return []
  }
  return environment.file.listFiles(backendPath)
}

async function run(environment: Environment, args: string[]): Promise<void> {
  await runProgram(environment, ['hammerkit', 'run', 'build', '--no-summary', ...args], true)
}

describe('read-only cache', () => {
  itExceptWindows('does not push to the backend with --cache-read-only', async () => {
    const backendPath = join(process.cwd(), 'temp', 'read-only-flag-backend')
    await createTestCase('read-only-flag', project(backendPath)).setup(async (cwd, environment) => {
      await environment.file.remove(backendPath)
      await run(environment, ['--cache-read-only'])
      expect(await environment.file.read(join(cwd, 'out', 'result.txt'))).toBe('hello\n')
      expect(await backendEntries(environment, backendPath)).toEqual([])
    })
  })

  itExceptWindows('does not push to the backend with HAMMERKIT_CACHE_READ_ONLY=1', async () => {
    const backendPath = join(process.cwd(), 'temp', 'read-only-env-backend')
    await createTestCase('read-only-env', project(backendPath)).setup(async (cwd, environment) => {
      await environment.file.remove(backendPath)
      environment.processEnvs = { ...environment.processEnvs, HAMMERKIT_CACHE_READ_ONLY: '1' }
      await run(environment, [])
      expect(await backendEntries(environment, backendPath)).toEqual([])
    })
  })

  itExceptWindows('pushes by default and restores in another checkout while read-only', async () => {
    const backendPath = join(process.cwd(), 'temp', 'read-only-restore-backend')

    // "CI": a writable run populates the shared backend
    await createTestCase('read-only-writer', project(backendPath)).setup(async (cwd, environment) => {
      await environment.file.remove(backendPath)
      await run(environment, [])
      expect((await backendEntries(environment, backendPath)).length).toBe(1)
    })

    // "agent sandbox": a different checkout, read-only, restores without executing
    await createTestCase('read-only-reader', project(backendPath)).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      const result = await cli.runExec({ cacheReadOnly: true })
      expect(result.success).toBe(true)
      expect(result.state.tasks['build'].state.current).toMatchObject({ type: 'completed', cached: true })
      expect(await environment.file.read(join(cwd, 'out', 'result.txt'))).toBe('hello\n')
    })
  })
})
