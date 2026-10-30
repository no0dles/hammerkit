import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Environment } from '../executer/environment'
import { getCheckKey } from './check-key'

function project(overrides: { [path: string]: unknown } = {}) {
  return {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      tasks: {
        install: { src: ['package.json'], generates: ['node_modules'], cmds: ['mkdir -p node_modules'] },
        build: { deps: ['install'], src: ['src'], generates: ['dist'], cmds: ['cat src/*.ts > dist/app.js'] },
        test: { deps: ['build'], src: ['test', 'dist'], cmds: ['cat test/a.spec.ts'] },
        lint: { cmds: ['echo lint'] },
      },
    },
    'package.json': '{}\n',
    'src/a.ts': 'a\n',
    'test/a.spec.ts': 'spec\n',
    ...overrides,
  }
}

async function keyIn(
  name: string,
  files: { [path: string]: unknown },
  task: string,
  prepare?: (cwd: string, environment: Environment) => Promise<void>
): Promise<string | null> {
  let key: string | null = null
  await createTestCase(name, files).setup(async (cwd, environment) => {
    await prepare?.(cwd, environment)
    const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: task })
    key = await getCheckKey(cli.task(task), environment)
  })
  return key
}

describe('check key', () => {
  it('is the same for the same files in another directory', async () => {
    const here = await keyIn('check-key-same-a', project(), 'test')
    const there = await keyIn('check-key-same-b/elsewhere', project(), 'test')
    expect(here).toMatch(/^[0-9a-f]{64}$/)
    expect(there).toBe(here)
  })

  it('changes with a file of its src, or of a dependency’s', async () => {
    const base = await keyIn('check-key-change-base', project(), 'test')
    expect(await keyIn('check-key-change-own', project({ 'test/a.spec.ts': 'other\n' }), 'test')).not.toBe(base)
    expect(await keyIn('check-key-change-dep', project({ 'src/a.ts': 'b\n' }), 'test')).not.toBe(base)
    expect(await keyIn('check-key-change-dep2', project({ 'package.json': '{"a":1}\n' }), 'test')).not.toBe(base)
  })

  it('changes with what the task runs', async () => {
    const base = await keyIn('check-key-cmd-base', project(), 'test')
    const changed = project()
    const buildFile = changed['.hammerkit.yaml'] as { tasks: { test: { cmds: string[] } } }
    buildFile.tasks.test.cmds = ['true']
    expect(await keyIn('check-key-cmd-changed', changed, 'test')).not.toBe(base)
  })

  it('leaves out files outside of src and .git', async () => {
    const base = await keyIn('check-key-outside-base', project(), 'test')
    const after = await keyIn('check-key-outside-written', project(), 'test', async (cwd, environment) => {
      // files no src names: a dependency's output nothing reads, and docs
      await environment.file.createDirectory(join(cwd, 'node_modules/.bin'))
      await environment.file.writeFile(join(cwd, 'node_modules/.bin/vitest'), 'exit 0\n')
      await environment.file.writeFile(join(cwd, 'README.md'), 'docs\n')
      // what a clone keeps of git, below a src too
      await environment.file.createDirectory(join(cwd, 'test/.git'))
      await environment.file.writeFile(join(cwd, 'test/.git/HEAD'), 'ref: refs/heads/other\n')
    })
    expect(after).toBe(base)
  })

  // the key is computed on a checkout before anything ran: a file there where a dependency
  // generates is one the commit holds, and a tool that finds it up to date leaves it as it is
  it('covers a file a commit holds where a dependency generates', async () => {
    const base = await keyIn('check-key-generated-base', project(), 'test')
    expect(await keyIn('check-key-generated-held', project({ 'dist/app.js': 'stale\n' }), 'test')).not.toBe(base)
  })

  it('covers the services a task needs and the sources of what they depend on', async () => {
    const files = (image: string, api: string) => ({
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': {
        tasks: {
          'build-api': { image: 'node:24-alpine', src: ['api'], generates: ['api-dist'], cmds: ['cp -r api api-dist'] },
          e2e: { image: 'node:24-alpine', src: ['e2e'], needs: ['api'], cmds: ['node e2e/a.js'] },
        },
        services: { api: { image, deps: ['build-api'], ports: ['3000'] } },
      },
      'api/main.js': api,
      'e2e/a.js': 'e2e\n',
    })
    const base = await keyIn('check-key-needs-base', files('node:24-alpine', 'ok\n'), 'e2e')
    expect(base).toMatch(/^[0-9a-f]{64}$/)
    expect(await keyIn('check-key-needs-image', files('node:20-alpine', 'ok\n'), 'e2e')).not.toBe(base)
    expect(await keyIn('check-key-needs-src', files('node:24-alpine', 'broken\n'), 'e2e')).not.toBe(base)
    // a service whose dependency can not be proven makes the task unprovable
    const unprovable = files('node:24-alpine', 'ok\n')
    const buildFile = unprovable['.hammerkit.yaml'] as { tasks: { 'build-api': { src: string[] } } }
    buildFile.tasks['build-api'].src = ['missing']
    expect(await keyIn('check-key-needs-unprovable', unprovable, 'e2e')).toBeNull()
  })

  it('is none, and comes back, for services that need each other', async () => {
    const files = {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': {
        services: {
          a: { image: 'alpine:3.19', cmd: 'sleep 300', needs: ['b'] },
          // with a dependency, the loop comes back after the first await
          b: { image: 'alpine:3.19', cmd: 'sleep 300', deps: ['prep'], needs: ['a'] },
        },
        tasks: {
          prep: { image: 'alpine:3.19', src: ['p.txt'], cmds: ['cat p.txt'] },
          t: { image: 'alpine:3.19', needs: ['a'], src: ['t.txt'], cmds: ['cat t.txt'] },
        },
      },
      't.txt': 'hello\n',
      'p.txt': 'p\n',
    }
    expect(await keyIn('check-key-needs-loop', files, 't')).toBeNull()
  })

  it('is none for a task that can not be proven up to date', async () => {
    expect(await keyIn('check-key-no-src', project(), 'lint')).toBeNull()
    const unmatched = project()
    const buildFile = unmatched['.hammerkit.yaml'] as { tasks: { install: { src: string[] } } }
    buildFile.tasks.install.src = ['missing.json']
    // a dependency that can not be proven makes the task unprovable too
    expect(await keyIn('check-key-unmatched-dep', unmatched, 'test')).toBeNull()
  })
})
