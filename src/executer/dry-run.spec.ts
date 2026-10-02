import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Cli } from '../cli'
import { Environment } from './environment'
import { computeStateKey } from './scheduler/state-key'
import { getLastResolvedFile, writeLastResolvedRecord } from '../cache/last-resolved'
import { getWorkTaskCacheDescription } from '../optimizer/work-task-cache-description'

// Same "simulate a successful run without spawning" helper used by the explain
// spec: write the local runtime state file + the last-resolved record.
async function simulateRun(cli: Cli, environment: Environment, taskName: string): Promise<void> {
  const item = cli.task(taskName)
  const { stateKey, stats } = await computeStateKey(item, 'checksum', environment)
  await environment.file.createDirectory(join(item.data.cwd, '.hammerkit'))
  await environment.file.writeFile(join(item.data.cwd, '.hammerkit', item.id()), stateKey)
  await writeLastResolvedRecord(environment, item, { description: getWorkTaskCacheDescription(item), stats })
}

describe('dry run (fast)', () => {
  it('produces an ordered plan annotated with predicted hit/miss (SC-003)', async () => {
    const t = createTestCase('dryrun-order', {
      '.hammerkit.yaml': {
        tasks: {
          base: { cmds: ['true'], src: ['base.txt'] },
          build: { cmds: ['true'], src: ['build.txt'], deps: ['base'] },
        },
      },
      'base.txt': 'b\n',
      'build.txt': 'x\n',
    })
    await t.setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      await cli.clean({ cache: true })
      await simulateRun(cli, environment, 'base')

      const plan = await cli.dryRun()
      expect(plan.cycle).toBeNull()
      // dependencies come before dependents
      expect(plan.entries.map((e) => e.taskName)).toEqual(['base', 'build'])
      expect(plan.entries.find((e) => e.taskName === 'base')?.status).toBe('hit')
      expect(plan.entries.find((e) => e.taskName === 'build')?.status).toBe('miss')
    })
  })

  it('executes nothing and records no run (SC-003 preview safety)', async () => {
    const t = createTestCase('dryrun-noexec', {
      '.hammerkit.yaml': { tasks: { solo: { cmds: ['true'], src: ['s.txt'] } } },
      's.txt': 'x\n',
    })
    await t.setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      await cli.clean({ cache: true })

      const plan = await cli.dryRun()
      expect(plan.entries.find((e) => e.taskName === 'solo')?.status).toBe('miss')
      // a dry run must not push/record anything
      expect(await environment.file.exists(getLastResolvedFile(cli.task('solo')))).toBe(false)
    })
  })

  it('reports a cyclic graph as an error', async () => {
    const t = createTestCase('dryrun-cycle', {
      '.hammerkit.yaml': {
        tasks: {
          a: { cmds: ['true'], deps: ['b'] },
          b: { cmds: ['true'], deps: ['a'] },
        },
      },
    })
    await t.setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      const plan = await cli.dryRun()
      expect(plan.cycle).not.toBeNull()
      expect(plan.entries).toHaveLength(0)
    })
  })
})
