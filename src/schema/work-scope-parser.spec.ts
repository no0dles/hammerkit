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
        httpRoutes: [],
        namespace: 'default',
        networkPolicyEnforced: false,
      })
    })

    it('reads that the cluster enforces NetworkPolicy', () => {
      const context = {
        environments: { default: { schema: { kubernetes: { context: 'prod', networkPolicy: 'enforced' } } } },
      } as unknown as ReferencedContext
      expect(defaultEnvironment(context)).toMatchObject({ type: 'kubernetes', networkPolicyEnforced: true })
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

    describe('names (up and down)', () => {
      const buildFile = {
        services: {
          postgres: { image: 'postgres:16', ports: ['5432'] },
          redis: { image: 'redis:7', ports: ['6379'] },
          mail: { image: 'mailhog/mailhog', ports: ['8025'] },
        },
        tasks: {
          install: { cmds: ['npm ci'] },
          serve: { cmds: ['npm start'], deps: ['install'], needs: ['postgres', 'redis'] },
          lint: { cmds: ['eslint'] },
        },
      }
      const names = (cli: Cli) => ({
        tasks: cli
          .tasks()
          .map((t) => t.item.name)
          .sort(),
        services: cli
          .services()
          .map((s) => s.item.name)
          .sort(),
      })

      it('selects a service by its name, and no task', async () => {
        await withCli(buildFile, { names: ['mail'] }, (cli) => {
          expect(names(cli)).toEqual({ tasks: [], services: ['mail'] })
        })
      })

      it('selects a task by its name, with its deps and the services it needs', async () => {
        await withCli(buildFile, { names: ['serve'] }, (cli) => {
          expect(names(cli)).toEqual({ tasks: ['install', 'serve'], services: ['postgres', 'redis'] })
        })
      })

      it('selects several names, tasks and services together', async () => {
        await withCli(buildFile, { names: ['lint', 'mail', 'postgres'] }, (cli) => {
          expect(names(cli)).toEqual({ tasks: ['lint'], services: ['mail', 'postgres'] })
        })
      })

      it('selects a service of an include by its full name', async () => {
        const testCase = createTestCase('work-scope-parser-include', {
          '.hammerkit.yaml': { includes: { infra: 'infra.yaml' } },
          'infra.yaml': { services: { postgres: { image: 'postgres:16', ports: ['5432'] } } },
        })
        await testCase.setup(async (cwd, environment) => {
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { names: ['infra:postgres'] })
          expect(names(cli)).toEqual({ tasks: [], services: ['infra:postgres'] })
        })
      })

      it('refuses a name that is no task or service', async () => {
        await expect(withCli(buildFile, { names: ['mail', 'postgress'] }, () => undefined)).rejects.toThrow(
          'no task or service named postgress, see hammerkit ls'
        )
      })
    })
  })
})
