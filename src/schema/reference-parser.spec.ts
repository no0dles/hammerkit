import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { join } from 'path'
import { WorkScope } from '../executer/work-scope'
import { Cli } from '../cli'
import { ParseError } from './parse-error'

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

  describe('extend chain', () => {
    it('gives the last task of a chain every base deps and each cmd once', async () => {
      await withCli(
        {
          tasks: {
            dep: { cmds: ['d'] },
            a: { deps: ['dep'], cmds: ['a'] },
            b: { extend: 'a', cmds: ['b'] },
            c: { extend: 'b', cmds: ['c'] },
          },
        },
        { taskName: 'c' },
        (cli) => {
          const c = cli.task('c')
          expect(c.deps.map((d) => d.name)).toEqual(['dep'])
          expect(c.data.cmds.map((cmd) => cmd.cmd)).toEqual(['a', 'b', 'c'])
        }
      )
    })

    it('keeps two tasks extending the same base independent', async () => {
      await withCli(
        {
          tasks: {
            base: { cmds: ['base'] },
            mid: { extend: 'base', cmds: ['mid'] },
            left: { extend: 'mid', cmds: ['left'] },
            right: { extend: 'mid', cmds: ['right'] },
          },
        },
        { taskName: 'right' },
        (cli) => {
          expect(cli.task('right').data.cmds.map((cmd) => cmd.cmd)).toEqual(['base', 'mid', 'right'])
        }
      )
    })

    it('rejects tasks that extend each other', async () => {
      const testCase = createTestCase('reference-parser', {
        '.hammerkit.yaml': { tasks: { a: { extend: 'b', cmds: ['a'] }, b: { extend: 'a', cmds: ['b'] } } },
      })
      await testCase.setup(async (cwd, environment) => {
        await expect(createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'a' })).rejects.toThrow(
          'extends itself'
        )
      })
    })
  })

  describe('extend', () => {
    async function withFiles(files: { [fileName: string]: any }, fn: (cwd: string, run: () => Promise<Cli>) => void) {
      await createTestCase('reference-parser-extend', files).setup(async (cwd, environment) => {
        await fn(cwd, () => createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' }))
      })
    }

    const base = {
      envs: { NODE_VERSION: 22, MODE: 'fast' },
      tasks: {
        install: { cmds: ['npm ci'] },
        build: { deps: ['install'], src: ['package.json'], cmds: ['npm run build'], envs: { CI: 'true' } },
      },
    }

    it('carries the top-level envs of the base build file, the consumer winning', async () => {
      await withFiles(
        {
          'base.yaml': base,
          '.hammerkit.yaml': {
            includes: { base: 'base.yaml' },
            tasks: { build: { extend: 'base:build', envs: { MODE: 'slow' } } },
          },
        },
        async (_cwd, run) => {
          const build = (await run()).task('build')
          expect(build.data.envs.variables).toEqual({ NODE_VERSION: '22', MODE: 'slow', CI: 'true' })
        }
      )
    })

    it('adds to deps, src and cmds of the base by default', async () => {
      await withFiles(
        {
          'base.yaml': base,
          '.hammerkit.yaml': {
            includes: { base: 'base.yaml' },
            tasks: {
              own: { cmds: ['echo own'] },
              build: { extend: 'base:build', deps: ['own'], src: ['tsconfig.json'], cmds: ['echo done'] },
            },
          },
        },
        async (_cwd, run) => {
          const build = (await run()).task('build')
          expect(build.deps.map((d) => d.name).sort()).toEqual(['base:install', 'own'])
          expect(build.data.src.map((s) => s.source)).toEqual(['package.json', 'tsconfig.json'])
          expect(build.data.cmds.map((c) => c.cmd)).toEqual(['npm run build', 'echo done'])
        }
      )
    })

    it('does not inherit what reset names', async () => {
      await withFiles(
        {
          'base.yaml': base,
          '.hammerkit.yaml': {
            includes: { base: 'base.yaml' },
            tasks: {
              own: { cmds: ['echo own'] },
              build: {
                extend: 'base:build',
                reset: ['deps', 'src', 'cmds', 'envs'],
                deps: ['own'],
                src: ['tsconfig.json'],
                cmds: ['echo done'],
              },
            },
          },
        },
        async (_cwd, run) => {
          const build = (await run()).task('build')
          expect(build.deps.map((d) => d.name)).toEqual(['own'])
          expect(build.data.src.map((s) => s.source)).toEqual(['tsconfig.json'])
          expect(build.data.cmds.map((c) => c.cmd)).toEqual(['echo done'])
          expect(build.data.envs.variables).toEqual({})
        }
      )
    })

    it('resets labels, generates, needs and mounts', async () => {
      await withFiles(
        {
          '.hammerkit.yaml': {
            services: { db: { image: 'postgres', ports: [] } },
            tasks: {
              base: {
                image: 'node',
                labels: { team: 'a' },
                generates: ['dist'],
                mounts: ['$PWD/.cache:/cache'],
                needs: ['db'],
                cmds: ['x'],
              },
              build: { extend: 'base', reset: ['labels', 'generates', 'mounts', 'needs'] },
            },
          },
        },
        async (_cwd, run) => {
          const build = (await run()).task('build')
          expect(build.needs).toEqual([])
          expect(build.data.generates).toEqual([])
          expect(build.data.labels).toEqual({})
          expect(build.data.type === 'container-task' && build.data.mounts).toEqual([])
        }
      )
    })

    it('does not pass on to a third task what the middle one reset', async () => {
      await withFiles(
        {
          '.hammerkit.yaml': {
            tasks: {
              first: { cmds: ['first'] },
              second: { cmds: ['second'] },
              a: { deps: ['first'], cmds: ['a'] },
              b: { extend: 'a', reset: ['deps'], deps: ['second'] },
              build: { extend: 'b', cmds: ['build'] },
            },
          },
        },
        async (_cwd, run) => {
          expect((await run()).task('build').deps.map((d) => d.name)).toEqual(['second'])
        }
      )
    })

    it('throws when reset is set without extend', async () => {
      await withFiles(
        { '.hammerkit.yaml': { tasks: { build: { cmds: ['x'], reset: ['deps'] } } } },
        async (_cwd, run) => {
          await expect(run()).rejects.toThrow('task build sets reset without extend')
        }
      )
    })

    it('rejects a property that cannot be reset', async () => {
      await withFiles(
        { '.hammerkit.yaml': { tasks: { a: { cmds: ['x'] }, build: { extend: 'a', reset: ['image'] } } } },
        async (_cwd, run) => {
          await expect(run()).rejects.toBeInstanceOf(ParseError)
        }
      )
    })
  })
})
