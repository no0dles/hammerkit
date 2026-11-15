import { join } from 'path'
import { createTestCase } from '../../testing/test-case'
import { createCli } from '../../program'
import { WorkTree } from '../work-tree'

describe('appendWorkDependencies', () => {
  it('keeps the task that made an output as its source through deps of deps', async () => {
    const testCase = createTestCase('append-work-dependencies', {
      '.hammerkit.yaml': {
        tasks: {
          install: { image: 'node', cmds: ['npm ci'], generates: ['node_modules'] },
          build: { image: 'node', deps: ['install'], cmds: ['tsc'], generates: ['dist'] },
          test: { image: 'node', deps: ['build'], cmds: ['vitest'] },
        },
        services: {
          api: { image: 'node', deps: ['build'], ports: ['3000'] },
        },
      },
    })
    await testCase.setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { mode: 'all' } as any)
      const workTree = (cli as unknown as { workTree: WorkTree }).workTree
      const task = (name: string) => Object.values(workTree.tasks).find((t) => t.name === name)!
      const service = Object.values(workTree.services).find((s) => s.name === 'api')!

      const made = (generates: { path: string; inherited: { name: string } | null }[]) =>
        Object.fromEntries(generates.map((g) => [g.path, g.inherited?.name ?? null]))
      const expected = { [join(cwd, 'dist')]: 'build', [join(cwd, 'node_modules')]: 'install' }
      expect(made(task('test').data.generates)).toEqual(expected)
      expect(
        made(
          service.data.type === 'container-service'
            ? service.data.volumes.map((v) => ({ path: v.containerPath, inherited: v.inherited }))
            : []
        )
      ).toEqual(expected)
    })
  })
})
