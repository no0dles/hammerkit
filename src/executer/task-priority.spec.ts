import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Cli } from '../cli'
import { Environment } from './environment'
import { getTaskPriority, readTaskDurations, recordTaskDuration } from './task-priority'
import { WorkTree } from '../planner/work-tree'
import { WorkItem } from '../planner/work-item'
import { WorkTask } from '../planner/work-task'

describe('task priority', () => {
  async function withCli(name: string, buildFile: unknown, fn: (cli: Cli, environment: Environment) => Promise<void>) {
    await createTestCase(name, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': buildFile,
    }).setup(async (cwd, environment) => {
      await fn(await createCli(join(cwd, '.hammerkit.yaml'), environment, {}), environment)
    })
  }

  const tree = (cli: Cli): WorkTree => cli['workTree']
  const task = (cli: Cli, name: string) => tree(cli).tasks[name]

  // install → build → e2e, a long chain; lint and docs alone, short
  const buildFile = {
    services: { db: { image: 'postgres:16', deps: ['migrations'] } },
    tasks: {
      install: { cmds: ['true'] },
      build: { deps: ['install'], cmds: ['true'] },
      e2e: { deps: ['build'], needs: ['db'], cmds: ['true'] },
      migrations: { cmds: ['true'] },
      lint: { cmds: ['true'] },
      docs: { cmds: ['true'] },
      ci: { deps: ['e2e', 'lint', 'docs'] },
    },
  }

  it('without durations counts the tasks of the longest chain after a task', async () => {
    await withCli('priority-count', buildFile, async (cli) => {
      const priority = getTaskPriority(tree(cli), {})
      // ci only groups the others, it counts nothing
      expect(priority(task(cli, 'install'))).toBe(3)
      expect(priority(task(cli, 'build'))).toBe(2)
      expect(priority(task(cli, 'lint'))).toBe(1)
      expect(priority(task(cli, 'ci'))).toBe(0)
    })
  })

  it('weighs the chain by what its tasks took, and carries it through a needed service', async () => {
    await withCli('priority-durations', buildFile, async (cli) => {
      const priority = getTaskPriority(tree(cli), { install: 10, build: 20, e2e: 300, lint: 100, docs: 5 })
      expect(priority(task(cli, 'install'))).toBe(330)
      expect(priority(task(cli, 'lint'))).toBe(100)
      // the service db needs migrations, and e2e needs db: migrations is on e2e's chain
      // (migrations has no duration, it counts the median of the others, 20)
      expect(priority(task(cli, 'migrations'))).toBe(320)
      expect(priority(tree(cli).services['db'])).toBe(300)
    })
  })

  it('counts a task that completed already as nothing', async () => {
    await withCli('priority-completed', buildFile, async (cli) => {
      const priority = getTaskPriority(tree(cli), { install: 10, build: 20, e2e: 300, lint: 100, docs: 5 })
      task(cli, 'e2e').state.set({ type: 'completed', cached: true, duration: 0, stateKey: 'x' })
      // its chain now ends at build: install 10 + build 20
      expect(priority(task(cli, 'install'))).toBe(30)
    })
  })

  it('keeps the last durations of a task on this machine and expects their median', async () => {
    // a directory of its own, so no earlier run's durations count
    const dir = mkdtempSync(join(tmpdir(), 'hk-durations-'))
    const before = process.env.HAMMERKIT_DIR
    process.env.HAMMERKIT_DIR = dir
    try {
      await recordDurations()
    } finally {
      if (before === undefined) {
        delete process.env.HAMMERKIT_DIR
      } else {
        process.env.HAMMERKIT_DIR = before
      }
      rmSync(dir, { recursive: true, force: true })
    }
  })

  const recordDurations = () =>
    withCli('priority-record', buildFile, async (cli, environment) => {
      const lint = task(cli, 'lint') as WorkItem<WorkTask>
      expect(await readTaskDurations(tree(cli), environment)).toEqual({})
      for (const ms of [500, 100, 300, 900, 700, 200]) {
        await recordTaskDuration(environment, lint, ms)
      }
      // the last five: 100 300 900 700 200, median 300
      expect(await readTaskDurations(tree(cli), environment)).toEqual({ lint: 300 })
    })
})
