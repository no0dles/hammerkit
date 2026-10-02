import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { runProgram } from '../run-program'
import { Environment } from './environment'
import { ParseError } from '../schema/parse-error'

// A task `timeout` (and the global `--timeout` default) turns a hang into a
// deterministic failure: the task is aborted, reported as timed out, and no
// cache entry is written for it.

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so gate these real runs off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

function project(localCache: string, task: { [key: string]: unknown }) {
  return {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      caches: { default: { method: 'checksum', backend: { type: 'local', path: localCache } } },
      tasks: { slow: { src: ['input.txt'], ...task } },
    },
    'input.txt': 'x\n',
  }
}

async function backendEntries(environment: Environment, path: string): Promise<number> {
  return (await environment.file.exists(path)) ? (await environment.file.listFiles(path)).length : 0
}

describe('task timeout', () => {
  itExceptWindows('fails a task that exceeds its timeout and writes no cache entry', async () => {
    const localCache = join(process.cwd(), 'temp', 'task-timeout-exceeded-local')
    await createTestCase('task-timeout-exceeded', project(localCache, { timeout: '1s', cmds: ['sleep 30'] })).setup(
      async (cwd, environment) => {
        await environment.file.remove(localCache)
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'slow' })
        const started = Date.now()
        const result = await cli.runExec()
        expect(Date.now() - started).toBeLessThan(15_000)
        expect(result.success).toBe(false)
        expect(result.state.tasks['slow'].state.current).toMatchObject({
          type: 'error',
          errorMessage: 'timed out after 1s',
        })
        expect(await backendEntries(environment, localCache)).toBe(0)
      }
    )
  })

  // A shell runs a compound command (and dash any command) as child processes;
  // stopping only the shell would leave them running and the task waiting on
  // their output until they finish on their own.
  itExceptWindows('stops every process a command started when the task times out', async () => {
    const localCache = join(process.cwd(), 'temp', 'task-timeout-children-local')
    await createTestCase(
      'task-timeout-children',
      project(localCache, { timeout: '1s', cmds: ['sleep 30; echo late'] })
    ).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'slow' })
      const started = Date.now()
      const result = await cli.runExec()
      expect(Date.now() - started).toBeLessThan(15_000)
      expect(result.state.tasks['slow'].state.current).toMatchObject({ type: 'error' })
    })
  })

  itExceptWindows('does not affect a task that finishes in time', async () => {
    const localCache = join(process.cwd(), 'temp', 'task-timeout-in-time-local')
    await createTestCase('task-timeout-in-time', project(localCache, { timeout: '30s', cmds: ['echo done'] })).setup(
      async (cwd, environment) => {
        await environment.file.remove(localCache)
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'slow' })
        const result = await cli.runExec()
        expect(result.success).toBe(true)
        expect(await backendEntries(environment, localCache)).toBe(1)
      }
    )
  })

  itExceptWindows('applies the global --timeout to tasks without their own', async () => {
    const localCache = join(process.cwd(), 'temp', 'task-timeout-global-local')
    await createTestCase('task-timeout-global', project(localCache, { cmds: ['sleep 30'] })).setup(
      async (cwd, environment) => {
        await environment.file.remove(localCache)
        await expect(
          runProgram(environment, ['hammerkit', 'run', 'slow', '--timeout', '1s', '--no-summary'], true)
        ).rejects.toThrow(/not successful/)
      }
    )
  })

  itExceptWindows("prefers the task's own timeout over the global one", async () => {
    const localCache = join(process.cwd(), 'temp', 'task-timeout-precedence-local')
    await createTestCase('task-timeout-precedence', project(localCache, { timeout: '30s', cmds: ['sleep 2'] })).setup(
      async (cwd, environment) => {
        await environment.file.remove(localCache)
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'slow' })
        const result = await cli.runExec({ timeout: 1000 })
        expect(result.success).toBe(true)
      }
    )
  })

  it('rejects an invalid timeout when the build file is read', async () => {
    const localCache = join(process.cwd(), 'temp', 'task-timeout-invalid-local')
    await createTestCase('task-timeout-invalid', project(localCache, { timeout: 'soon', cmds: ['echo'] })).setup(
      async (cwd, environment) => {
        const error = await createCli(join(cwd, '.hammerkit.yaml'), environment, {}).catch((e) => e)
        expect(error).toBeInstanceOf(ParseError)
        expect(error.zod.errors.map((issue: { message: string }) => issue.message)).toContain(
          'invalid duration "soon", expected e.g. 30s, 5m, 1h30m or 30d'
        )
      }
    )
  })
})
