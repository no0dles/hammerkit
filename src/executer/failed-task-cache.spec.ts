import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Cli } from '../cli'
import { Environment } from './environment'

// A task that did not succeed must never be reported as up to date: not on the
// next run, and not to another machine through `cache push`. Otherwise a
// failing test passes on its second run, and CI pulling the pushed entry skips
// it entirely.

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so gate these real runs off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

function project(name: string, task: { [key: string]: unknown }) {
  const remote = join(process.cwd(), 'temp', `${name}-remote`)
  return createTestCase(name, {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      caches: { shared: { method: 'checksum', backend: { type: 'local', path: remote } } },
      tasks: { test: { src: ['input.txt'], generates: ['report'], ...task } },
    },
    'input.txt': 'x\n',
  })
}

const failing = { cmds: ['mkdir -p report', 'echo partial > report/result.txt', 'exit 1'] }

// A failed run aborts its environment; every hammerkit command starts with a fresh one.
function run(cli: Cli, environment: Environment, options?: Parameters<Cli['runExec']>[0]) {
  environment.abortCtrl = new AbortController()
  return cli.runExec(options)
}

describe('a task that did not succeed', () => {
  itExceptWindows('runs again on the next run', async () => {
    await project('failed-task-reruns', failing).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
      await cli.clean({ cache: true })
      for (let attempt = 0; attempt < 2; attempt++) {
        const result = await run(cli, environment)
        expect(result.success).toBe(false)
        expect(result.state.tasks['test'].state.current.type).toBe('crash')
      }
    })
  })

  itExceptWindows('is not pushed to a remote cache', async () => {
    await project('failed-task-not-pushed', failing).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
      await cli.clean({ cache: true })
      await environment.file.remove(join(process.cwd(), 'temp', 'failed-task-not-pushed-remote'))
      expect((await run(cli, environment)).success).toBe(false)
      const pushed = await cli.syncCache({ direction: 'push', remote: 'shared', cacheDefault: 'checksum' })
      expect(pushed.find((result) => result.taskName === 'test')?.status).toBe('missing')
    })
  })

  itExceptWindows(
    'runs again after it timed out',
    async () => {
      await project('timed-out-task-reruns', { timeout: '1s', cmds: ['sleep 5'] }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
        await cli.clean({ cache: true })
        for (let attempt = 0; attempt < 2; attempt++) {
          const result = await run(cli, environment)
          expect(result.success).toBe(false)
          // a cached task would complete; this one runs into its timeout again
          expect(result.state.tasks['test'].state.current).toMatchObject({ type: 'error' })
        }
      })
    },
    20000
  )

  // A forced rerun (`--cache none`) that fails leaves partial outputs behind.
  // The next run may restore the earlier success from the cache, but then with
  // that run's outputs, not the failed run's leftovers.
  itExceptWindows('leaves no partial outputs behind a later cache hit', async () => {
    await project('failed-rerun-forgets-success', {
      cmds: [
        'mkdir -p report',
        'cp input.txt report/',
        'if [ -f fail ]; then echo partial > report/partial.txt; exit 1; fi',
      ],
    }).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
      await cli.clean({ cache: true })
      expect((await run(cli, environment)).success).toBe(true)

      await environment.file.writeFile(join(cwd, 'fail'), '')
      expect((await run(cli, environment, { cacheDefault: 'none' })).success).toBe(false)
      await environment.file.remove(join(cwd, 'fail'))

      const third = await run(cli, environment)
      expect(third.success).toBe(true)
      expect(await environment.file.exists(join(cwd, 'report', 'partial.txt'))).toBe(false)
    })
  })
})
