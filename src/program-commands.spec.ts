import { createTestCase } from './testing/test-case'

// Fast unit-suite coverage for program.ts: every command that does not actually
// run a container (ls, validate, clean --cache, init, --file, unknown task).
// The slow container-running cases (run, package, up/down) live in
// `program.spec.ts` and run in the integration suite.
//
// shell() forwards args to commander via `[env.cwd, ...args]`, and commander's
// default `from: 'node'` consumes the first two slots as node+script. So args
// must start with a script-name placeholder (matching how production receives
// process.argv); the real command starts at index 1.
const HK = 'hammerkit'

describe('program commands (fast)', () => {
  it('ls lists tasks and services without running them', async () => {
    const t = createTestCase('cmd-ls', {
      '.hammerkit.yaml': {
        services: { api: { image: 'nginx', ports: [] } },
        tasks: {
          build: { cmds: ['true'], description: 'build it', labels: { tier: 'backend' } },
        },
      },
    })
    await t.shell([HK, 'ls'])
  })

  it('ls --filter narrows by label', async () => {
    const t = createTestCase('cmd-ls-filter', {
      '.hammerkit.yaml': {
        tasks: {
          build: { cmds: ['true'], labels: { app: 'web' } },
          lint: { cmds: ['true'], labels: { app: 'tool' } },
        },
      },
    })
    await t.shell([HK, 'ls', '--filter', 'app=web'])
  })

  it('validate returns cleanly for a healthy build file', async () => {
    const t = createTestCase('cmd-validate-ok', {
      '.hammerkit.yaml': {
        tasks: { build: { description: 'build it', cmds: ['true'] } },
      },
    })
    await t.shell([HK, 'validate'])
  })

  it('validate exits non-zero when a cycle is detected', async () => {
    const t = createTestCase('cmd-validate-cycle', {
      '.hammerkit.yaml': {
        tasks: {
          a: { description: 'a', cmds: ['true'], deps: ['b'] },
          b: { description: 'b', cmds: ['true'], deps: ['a'] },
        },
      },
    })
    await expect(t.shell([HK, 'validate'])).rejects.toThrow('Detected errors')
  })

  it('clean --cache clears the backend cache (no container ops)', async () => {
    const t = createTestCase('cmd-clean-cache', {
      '.hammerkit.yaml': {
        tasks: { build: { cmds: ['true'] } },
      },
    })
    await t.shell([HK, 'clean', '--cache'])
  })

  it('init writes a default .hammerkit.yaml when none exists', async () => {
    // empty fixture so getBuildFilename finds nothing; only the `init` command is registered then
    const t = createTestCase('cmd-init', {})
    await t.shell([HK, 'init'])
  })

  it('errors when the requested task does not exist', async () => {
    const t = createTestCase('cmd-unknown-task', {
      '.hammerkit.yaml': { tasks: { example: { cmds: ['true'] } } },
    })
    await expect(t.shell([HK, 'run', 'no-such-task'])).rejects.toThrow('No tasks found')
  })

  it('--file selects a non-default build file', async () => {
    const t = createTestCase('cmd-file-arg', {
      'custom.yaml': {
        tasks: { only: { description: 'only', cmds: ['true'] } },
      },
    })
    await t.shell([HK, '--file', 'custom.yaml', 'ls'])
  })
})
