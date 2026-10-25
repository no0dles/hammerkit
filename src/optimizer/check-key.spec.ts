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

  it('leaves out what dependencies generate and files outside of src', async () => {
    const base = await keyIn('check-key-outputs-base', project(), 'test')
    const after = await keyIn('check-key-outputs-written', project(), 'test', async (cwd, environment) => {
      // what a dependency made, and files no src names: in a fresh checkout they are not there
      await environment.file.createDirectory(join(cwd, 'dist'))
      await environment.file.writeFile(join(cwd, 'dist/app.js'), 'anything\n')
      await environment.file.createDirectory(join(cwd, 'node_modules/.bin'))
      await environment.file.writeFile(join(cwd, 'node_modules/.bin/vitest'), 'exit 0\n')
      await environment.file.writeFile(join(cwd, 'README.md'), 'docs\n')
    })
    expect(after).toBe(base)
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
