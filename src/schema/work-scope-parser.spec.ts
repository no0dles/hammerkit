import { defaultEnvironment } from './work-scope-parser'
import { ReferencedContext } from './reference-parser'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { join } from 'path'
import { WorkScope } from '../executer/work-scope'
import { Cli } from '../cli'

async function withCli(buildFile: any, scope: WorkScope, fn: (cli: Cli) => void | Promise<void>): Promise<void> {
  const testCase = createTestCase('work-scope-parser', { '.hammerkit.yaml': buildFile })
  await testCase.setup(async (cwd, environment) => {
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, scope)
    await fn(cli)
  })
}

describe('work-scope-parser', () => {
  describe('defaultEnvironment', () => {
    it('falls back to docker when no default environment is declared', () => {
      expect(defaultEnvironment({ environments: {} } as unknown as ReferencedContext)).toEqual({ type: 'docker' })
    })

    it('uses a declared docker default environment', () => {
      const context = {
        environments: { default: { schema: { docker: { host: 'tcp://remote:2375' } } } },
      } as unknown as ReferencedContext
      expect(defaultEnvironment(context)).toEqual({ type: 'docker', host: 'tcp://remote:2375' })
    })

    it('uses a declared kubernetes default environment', () => {
      const context = {
        environments: { default: { schema: { kubernetes: { context: 'prod' } } } },
      } as unknown as ReferencedContext
      expect(defaultEnvironment(context)).toEqual({
        type: 'kubernetes',
        context: 'prod',
        ingresses: [],
        namespace: 'default',
      })
    })
  })

  describe('getWorkContext (via createCli)', () => {
    it('includes only the requested task and its dependencies', async () => {
      await withCli(
        {
          tasks: {
            install: { cmds: ['npm install'] },
            build: { cmds: ['tsc'], deps: ['install'] },
            lint: { cmds: ['eslint'] },
          },
        },
        { taskName: 'build' },
        (cli) => {
          const names = cli
            .tasks()
            .map((t) => t.item.name)
            .sort()
          expect(names).toEqual(['build', 'install'])
          expect(() => cli.task('lint')).toThrow('unable to find task lint')
        }
      )
    })

    it('filters tasks by label', async () => {
      await withCli(
        {
          tasks: {
            build: { cmds: ['tsc'], labels: { app: 'web' } },
            lint: { cmds: ['eslint'], labels: { app: 'tool' } },
          },
        },
        { filterLabels: { app: ['web'] } },
        (cli) => {
          expect(cli.tasks().map((t) => t.item.name)).toEqual(['build'])
        }
      )
    })
  })
})
