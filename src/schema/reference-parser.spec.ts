import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { join } from 'path'
import { WorkScope } from '../executer/work-scope'
import { Cli } from '../cli'

// Drive the full parse pipeline (schema-parser -> parseReferences -> getWorkContext)
// over an in-memory build file and assert on the resulting work tree. This exercises
// reference resolution: deps, needs, label merging and schema `extend`.
async function withCli(buildFile: any, scope: WorkScope, fn: (cli: Cli) => void | Promise<void>): Promise<void> {
  const testCase = createTestCase('reference-parser', { '.hammerkit.yaml': buildFile })
  await testCase.setup(async (cwd, environment) => {
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, scope)
    await fn(cli)
  })
}

describe('reference-parser', () => {
  it('resolves task dependencies', async () => {
    await withCli(
      {
        tasks: {
          install: { cmds: ['npm install'] },
          build: { cmds: ['tsc'], deps: ['install'] },
        },
      },
      { taskName: 'build' },
      (cli) => {
        const build = cli.task('build')
        expect(build.deps.map((d) => d.name)).toEqual(['install'])
      }
    )
  })

  it('resolves service needs', async () => {
    await withCli(
      {
        services: {
          api: { image: 'nginx', ports: [] },
        },
        tasks: {
          build: { cmds: ['tsc'], needs: ['api'] },
        },
      },
      { taskName: 'build' },
      (cli) => {
        const build = cli.task('build')
        expect(build.needs.map((n) => n.service.name)).toEqual(['api'])
      }
    )
  })

  it('merges build-file labels with task labels', async () => {
    await withCli(
      {
        labels: { app: 'web' },
        tasks: {
          build: { cmds: ['tsc'], labels: { tier: 'backend' } },
        },
      },
      { taskName: 'build' },
      (cli) => {
        expect(cli.task('build').data.labels).toEqual({ app: ['web'], tier: ['backend'] })
      }
    )
  })

  it('applies schema extend (image, cmds, labels)', async () => {
    await withCli(
      {
        tasks: {
          base: { image: 'node', cmds: ['a'] },
          child: { extend: 'base', cmds: ['b'] },
        },
      },
      { taskName: 'child' },
      (cli) => {
        const child = cli.task('child').data
        // child inherits the base image and is therefore a container task
        expect(child.type).toBe('container-task')
        expect((child as any).image).toBe('node')
        // extendArray prepends the extended task's cmds before the child's own
        expect(child.cmds).toHaveLength(2)
      }
    )
  })

  it('throws when a dependency cannot be found', async () => {
    const testCase = createTestCase('reference-parser', {
      '.hammerkit.yaml': { tasks: { build: { cmds: ['tsc'], deps: ['missing'] } } },
    })
    await testCase.setup(async (cwd, environment) => {
      await expect(createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })).rejects.toThrow(
        'unable to find missing'
      )
    })
  })

  it('throws when a needed service cannot be found', async () => {
    const testCase = createTestCase('reference-parser', {
      '.hammerkit.yaml': { tasks: { build: { cmds: ['tsc'], needs: ['missingsvc'] } } },
    })
    await testCase.setup(async (cwd, environment) => {
      await expect(createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })).rejects.toThrow(
        'unable to find missingsvc'
      )
    })
  })
})
