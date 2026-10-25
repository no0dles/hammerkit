import { join } from 'path'
import { tmpdir } from 'os'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { getCheckKeys } from '../optimizer/check-keys'
import { computeStateKey } from '../executer/scheduler/state-key'
import { applyNetworkCeiling } from './work-network'
import { isAggregateTask } from './work-task'
import { planBundle } from '../server/plan'
import { environmentMock } from '../executer/environment-mock'
import { Environment } from '../executer/environment'

// the shape of iwentsourcing's build file: aggregates over container tasks
const tasks = {
  install: { image: 'node:24-alpine', src: ['package.json'], generates: ['node_modules'], cmds: ['npm ci'] },
  build: { image: 'node:24-alpine', deps: ['install'], src: ['src'], generates: ['dist'], cmds: ['npm run build'] },
  'build:all': { deps: ['build'] },
  'test:unit': { image: 'node:24-alpine', deps: ['build:all'], src: ['test'], cmds: ['npm test'] },
  'ci:check': { deps: ['test:unit', 'build:all'] },
  // not an aggregate: it runs something, or reads something
  local: { deps: ['build'], cmds: ['echo'] },
  secret: { deps: ['build'], secrets: [{ from: 'env:TOKEN', env: 'TOKEN' }] },
}

const project = {
  '.git/HEAD': 'ref: refs/heads/main\n',
  '.hammerkit.yaml': { tasks },
  'package.json': '{}\n',
  'src/a.ts': 'a\n',
  'test/a.spec.ts': 'spec\n',
}

async function withCli(name: string, fn: (cli: Awaited<ReturnType<typeof createCli>>, env: Environment) => unknown) {
  await createTestCase(name, project).setup(async (cwd, environment) => {
    environment.processEnvs = { ...environment.processEnvs, TOKEN: 'x' }
    await fn(await createCli(join(cwd, '.hammerkit.yaml'), environment, {}), environment)
  })
}

describe('aggregate tasks', () => {
  it('is a task with deps and nothing to run, read or generate', async () => {
    await withCli('aggregate-kind', (cli) => {
      expect(isAggregateTask(cli.task('build:all').data)).toBe(true)
      expect(isAggregateTask(cli.task('ci:check').data)).toBe(true)
      expect(isAggregateTask(cli.task('local').data)).toBe(false)
      expect(isAggregateTask(cli.task('secret').data)).toBe(false)
      expect(isAggregateTask(cli.task('build').data)).toBe(false)
    })
  })

  it('hands on what its dependencies generate, kept as theirs', async () => {
    await withCli('aggregate-generates', (cli) => {
      const generates = cli.task('test:unit').data.generates.filter((g) => g.inherited)
      expect(generates.map((g) => [g.path.split(/[\\/]/).pop(), g.inherited?.name]).sort()).toEqual([
        ['dist', 'build'],
        ['node_modules', 'install'],
      ])
    })
  })

  it('is provable when its dependencies are, so what depends on it can be cached', async () => {
    await withCli('aggregate-provable', async (cli, environment) => {
      expect((await computeStateKey(cli.task('build:all'), 'checksum', environment)).provable).toBe(true)
      expect((await computeStateKey(cli.task('ci:check'), 'checksum', environment)).provable).toBe(true)
      // a task without src that runs something stays unprovable
      expect((await computeStateKey(cli.task('local'), 'checksum', environment)).provable).toBe(false)
    })
  })

  it('has a check key, and so has what depends on it', async () => {
    await createTestCase('aggregate-check-keys', project).setup(async (cwd, environment) => {
      const keys = await getCheckKeys(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'ci:check' })
      for (const task of ['build:all', 'test:unit', 'ci:check']) {
        expect(keys[task]).toEqual({ key: expect.stringMatching(/^[0-9a-f]{64}$/) })
      }
      // its key follows its dependencies' files
      await environment.file.writeFile(join(cwd, 'src/a.ts'), 'b\n')
      const changed = await getCheckKeys(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'ci:check' })
      expect(changed['build:all'].key).not.toEqual(keys['build:all'].key)
    })
  })

  it('is no local task to limit under --network', async () => {
    await createTestCase('aggregate-network', {
      ...project,
      '.hammerkit.yaml': { tasks: { build: tasks.build, install: tasks.install, 'build:all': tasks['build:all'] } },
    }).setup(async (cwd, environment) => {
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      expect(() => applyNetworkCeiling((cli as any).workTree, { type: 'none' })).not.toThrow()
    })
  })

  it('needs no runtime on a server', async () => {
    const hosted: Environment = {
      ...environmentMock(tmpdir()),
      processEnvs: { PATH: '/bin' },
      hosted: { catalog: { providers: {}, accounts: {}, explicitAccounts: true } },
    }
    const yaml =
      'tasks:\n  build:\n    image: node:24\n    src: [src]\n    network: none\n    cmds: [echo]\n' +
      '  build:all:\n    deps: [build]\n  local:\n    deps: [build]\n    cmds: [echo]\n'
    const bundle = (scope: string) =>
      planBundle({ entry: '.hammerkit.yaml', files: { '.hammerkit.yaml': yaml, 'src/a.ts': 'a' } }, hosted, {
        scope: { taskName: scope },
        policy: { envs: [], runtimes: ['docker'], network: { type: 'none' } },
      })
    const planned = await bundle('build:all')
    expect(planned.plan['build:all']).toMatchObject({ runtime: 'none', flags: [] })
    await expect(bundle('local')).rejects.toThrow('local: runs on the local runtime')
  })
})
