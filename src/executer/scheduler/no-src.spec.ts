import { join } from 'path'
import { createTestCase } from '../../testing/test-case'
import { createCli } from '../../program'

// A task without `src` cannot be proven up to date, so it always runs — and so
// does everything depending on it (specs/task SC-001, docs/faq). Its state key
// would otherwise be a constant and it would be skipped forever after one run.

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so gate these real runs off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

describe('tasks without src', () => {
  itExceptWindows('always run, and so do their dependents', async () => {
    await createTestCase('no-src-always-runs', {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': {
        tasks: {
          prepare: { cmds: ['echo prepare'] },
          build: { deps: ['prepare'], src: ['input.txt'], cmds: ['echo build'] },
          lint: { src: ['input.txt'], cmds: ['echo lint'] },
        },
      },
      'input.txt': 'x\n',
    }).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      await cli.clean({ cache: true })
      for (let run = 0; run < 2; run++) {
        const result = await cli.runExec()
        expect(result.success).toBe(true)
        expect(result.state.tasks['prepare'].state.current).toMatchObject({ type: 'completed', cached: false })
        expect(result.state.tasks['build'].state.current).toMatchObject({ type: 'completed', cached: false })
      }
      // a task with src is still cached on the second run
      const third = await cli.runExec()
      expect(third.state.tasks['lint'].state.current).toMatchObject({ type: 'completed', cached: true })
    })
  })
})
