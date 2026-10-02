import { join } from 'path'
import { createTestCase } from '../../testing/test-case'
import { createCli } from '../../program'
import { memoryStream } from '../../testing/test-streams'
import { statusConsole } from '../../planner/work-item-status'

// A task without `src` cannot be proven up to date, so it always runs — and so
// does everything depending on it (specs/task SC-001, the FAQ). Its state key
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

  // src that matches no files (a typo, a path that moved) gives the same
  // constant key as no src at all, so it gets the same treatment.
  itExceptWindows('always run when their src matches no files, and so do their dependents', async () => {
    await createTestCase('no-src-files-always-runs', {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': {
        tasks: {
          prepare: { src: ['scr'], cmds: ['echo prepare'] },
          build: { deps: ['prepare'], src: ['input.txt'], cmds: ['echo build'] },
        },
      },
      'src/app.ts': 'x\n',
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
    })
  })

  itExceptWindows('warn about each src entry that matches no files', async () => {
    await createTestCase('no-src-files-warns', {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': { tasks: { build: { src: ['scr', 'input.txt'], cmds: ['echo build'] } } },
      'input.txt': 'x\n',
    }).setup(async (cwd, environment) => {
      const status = memoryStream()
      environment.status = statusConsole(status.stream)
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      await cli.clean({ cache: true })
      expect((await cli.runExec()).success).toBe(true)
      const warnings = status
        .read()
        .split('\n')
        .filter((line) => line.includes('"level":"warn"'))
      expect(warnings.some((line) => line.includes('src \\"scr\\" matches no files'))).toBe(true)
      expect(warnings.some((line) => line.includes('input.txt'))).toBe(false)
    })
  })

  // Its dependency's sources say nothing about the files its own commands read
  // (a test task's test files), so they don't make it provable (SC-001).
  itExceptWindows('always run when only their dependencies declare src', async () => {
    await createTestCase('no-own-src-always-runs', {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': {
        tasks: {
          build: { src: ['input.txt'], cmds: ['echo build'] },
          test: { deps: ['build'], cmds: ['echo test'] },
        },
      },
      'input.txt': 'x\n',
    }).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
      await cli.clean({ cache: true })
      for (let run = 0; run < 2; run++) {
        const result = await cli.runExec()
        expect(result.success).toBe(true)
        expect(result.state.tasks['test'].state.current).toMatchObject({ type: 'completed', cached: false })
      }
    })
  })

  itExceptWindows('do not warn about src a dependency generates before it ran', async () => {
    await createTestCase('no-src-files-dep-output', {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': {
        tasks: {
          build: { src: ['input.txt'], generates: ['dist'], cmds: ['mkdir -p dist', 'cp input.txt dist/app.js'] },
          e2e: { deps: ['build'], src: ['dist', 'input.txt'], cmds: ['cat dist/app.js'] },
        },
      },
      'input.txt': 'x\n',
    }).setup(async (cwd, environment) => {
      const status = memoryStream()
      environment.status = statusConsole(status.stream)
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'e2e' })
      await cli.clean({ cache: true })
      expect((await cli.runExec()).success).toBe(true)
      expect(status.read()).not.toContain('matches no files')
    })
  })
})
