import { join } from 'path'
import { existsSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { stringify } from 'yaml'
import { createTestCase } from '../../testing/test-case'
import { createCli } from '../../program'
import { Environment } from '../environment'
import { checkCacheState } from './enqueue-next'
import { CacheMethod } from '../../parser/cache-method'

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so cases that run tasks are gated off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

// A false hit — serving a stale entry as fresh after an input changed — is a
// defect, never a speed trade (CONTEXT.md, "State key"). Each case here changes
// exactly one input a task can observe and asserts the cache notices.

async function stateKey(cwd: string, environment: Environment, taskName: string): Promise<string> {
  const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName })
  return (await checkCacheState(cli.task(taskName), 'checksum', environment)).stateKey
}

async function keyChangesWhen(
  name: string,
  files: { [path: string]: any },
  change: (cwd: string) => void,
  prepare?: (cwd: string) => void
): Promise<boolean> {
  let changed = false
  await createTestCase(name, { '.git/HEAD': 'ref: refs/heads/main\n', ...files }).setup(async (cwd, environment) => {
    prepare?.(cwd)
    const before = await stateKey(cwd, environment, 't')
    change(cwd)
    changed = (await stateKey(cwd, environment, 't')) !== before
  })
  return changed
}

describe('cache invalidation', () => {
  describe('glob sources', () => {
    it('notices a change in a nested file matched by src/**/*.ts', async () => {
      const changed = await keyChangesWhen(
        'invalidation-nested-glob',
        {
          '.hammerkit.yaml': { tasks: { t: { src: ['src/**/*.ts'], cmds: ['echo'] } } },
          'src/top.ts': 'top',
          'src/a/b/deep.ts': 'v1',
        },
        (cwd) => writeFileSync(join(cwd, 'src/a/b/deep.ts'), 'v2')
      )
      expect(changed).toBe(true)
    })

    it('notices a change in a file matched by **/*.ts', async () => {
      const changed = await keyChangesWhen(
        'invalidation-leading-glob',
        {
          '.hammerkit.yaml': { tasks: { t: { src: ['**/*.ts'], cmds: ['echo'] } } },
          'lib/a/deep.ts': 'v1',
        },
        (cwd) => writeFileSync(join(cwd, 'lib/a/deep.ts'), 'v2')
      )
      expect(changed).toBe(true)
    })

    // the glob set promised by specs/task/caching FR-010, not only `*`
    it.each([
      ['a wildcard inside a file name', 'src/app*.ts', 'src/app-main.ts'],
      ['?', 'src/?.ts', 'src/a.ts'],
      ['a character class', 'src/[ab].ts', 'src/a.ts'],
      ['braces', '{src,lib}/*.ts', 'lib/a.ts'],
      ['an extglob', 'src/@(a|b).ts', 'src/a.ts'],
      ['a leading ./', './src/*.ts', 'src/a.ts'],
      ['braces of plain names', '{package,tsconfig}.json', 'tsconfig.json'],
    ])('notices a change in a file matched by %s (%s)', async (_, pattern, file) => {
      const changed = await keyChangesWhen(
        `invalidation-glob-${pattern.replace(/[^a-z]+/gi, '-')}`,
        { '.hammerkit.yaml': { tasks: { t: { src: [pattern], cmds: ['echo'] } } }, [file]: 'v1' },
        (cwd) => writeFileSync(join(cwd, file), 'v2')
      )
      expect(changed).toBe(true)
    })

    it('notices a change in a file matched by a glob that uses an env variable', async () => {
      const changed = await keyChangesWhen(
        'invalidation-env-glob',
        {
          '.hammerkit.yaml': { tasks: { t: { envs: { DIR: 'src' }, src: ['$DIR/*.ts'], cmds: ['echo'] } } },
          'src/app.ts': 'v1',
        },
        (cwd) => writeFileSync(join(cwd, 'src/app.ts'), 'v2')
      )
      expect(changed).toBe(true)
    })
  })

  describe('file contents', () => {
    it('notices a changed byte in a binary source', async () => {
      // 0x80 and 0xff are both invalid UTF-8; hashing decoded text maps both to U+FFFD
      const changed = await keyChangesWhen(
        'invalidation-binary',
        { '.hammerkit.yaml': { tasks: { t: { src: ['logo.png'], cmds: ['echo'] } } } },
        (cwd) => writeFileSync(join(cwd, 'logo.png'), Buffer.from([0x89, 0x50, 0xff, 0x00])),
        (cwd) => writeFileSync(join(cwd, 'logo.png'), Buffer.from([0x89, 0x50, 0x80, 0x00]))
      )
      expect(changed).toBe(true)
    })
  })

  describe('dependencies', () => {
    // build writes out.txt, consume copies it; only build's definition changes
    function buildFile(build: { cmds: string[]; envs?: { [key: string]: string } }) {
      return {
        tasks: {
          build: { src: ['in.txt'], generates: ['out.txt'], ...build },
          consume: { deps: ['build'], src: ['c.txt'], generates: ['final.txt'], cmds: ['cp out.txt final.txt'] },
        },
      }
    }

    async function consumeAfterChange(
      name: string,
      before: ReturnType<typeof buildFile>,
      after: ReturnType<typeof buildFile>
    ): Promise<string> {
      let output = ''
      await createTestCase(name, {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': before,
        'in.txt': 'in',
        'c.txt': 'c',
      }).setup(async (cwd, environment) => {
        const run = async () => {
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'consume' })
          await cli.clean({ cache: true })
          expect((await cli.runExec()).success).toBe(true)
        }
        await run()
        writeFileSync(join(cwd, '.hammerkit.yaml'), stringify(after))
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'consume' })
        expect((await cli.runExec()).success).toBe(true)
        output = readFileSync(join(cwd, 'final.txt'), 'utf8').trim()
      })
      return output
    }

    // A dependency's outputs are represented by its task id and state key, so a
    // task reading them as src gets the same key on a clean checkout (outputs not
    // built yet) as after the dependency ran — the entry an agent pushed from a
    // built workspace is the one a clean CI checkout looks up.
    itExceptWindows(
      'keys a task reading a dependency output the same before and after the dependency ran',
      async () => {
        await createTestCase('invalidation-dep-output-src', {
          '.git/HEAD': 'ref: refs/heads/main\n',
          '.hammerkit.yaml': {
            tasks: {
              build: { src: ['in.txt'], generates: ['dist'], cmds: ['mkdir -p dist', 'cp in.txt dist/app.js'] },
              e2e: { deps: ['build'], src: ['e2e.txt', 'dist'], cmds: ['cat dist/app.js'] },
            },
          },
          'in.txt': 'in',
          'e2e.txt': 'e2e',
        }).setup(async (cwd, environment) => {
          const clean = await stateKey(cwd, environment, 'e2e')
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
          await cli.clean({ cache: true })
          expect((await cli.runExec()).success).toBe(true)
          expect(await stateKey(cwd, environment, 'e2e')).toBe(clean)
        })
      }
    )

    itExceptWindows('keeps dependency outputs a dependant glob matches out of its key', async () => {
      await createTestCase('invalidation-dep-output-glob', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            build: { src: ['in.txt'], generates: ['dist'], cmds: ['mkdir -p dist', 'cp in.txt dist/app.js'] },
            lint: { deps: ['build'], src: ['**/*.js'], cmds: ['echo lint'] },
          },
        },
        'in.txt': 'in',
        'lint.js': 'lint',
      }).setup(async (cwd, environment) => {
        const clean = await stateKey(cwd, environment, 'lint')
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
        await cli.clean({ cache: true })
        expect((await cli.runExec()).success).toBe(true)
        expect(await stateKey(cwd, environment, 'lint')).toBe(clean)
      })
    })

    // outputs of dependencies further up the chain count too, and so does a src
    // naming a single file inside an output directory
    itExceptWindows('keeps outputs of transitive dependencies out of a task key', async () => {
      await createTestCase('invalidation-dep-output-transitive', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            build: { src: ['in.txt'], generates: ['dist'], cmds: ['mkdir -p dist', 'cp in.txt dist/app.js'] },
            bundle: { deps: ['build'], src: ['bundle.txt'], cmds: ['echo bundle'] },
            e2e: { deps: ['bundle'], src: ['e2e.txt', 'dist/app.js'], cmds: ['cat dist/app.js'] },
          },
        },
        'in.txt': 'in',
        'bundle.txt': 'bundle',
        'e2e.txt': 'e2e',
      }).setup(async (cwd, environment) => {
        const clean = await stateKey(cwd, environment, 'e2e')
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
        await cli.clean({ cache: true })
        expect((await cli.runExec()).success).toBe(true)
        expect(await stateKey(cwd, environment, 'e2e')).toBe(clean)
      })
    })

    itExceptWindows('rebuilds a dependant when its dependency command changes', async () => {
      const output = await consumeAfterChange(
        'invalidation-dep-cmd',
        buildFile({ cmds: ['echo v1 > out.txt'] }),
        buildFile({ cmds: ['echo v2 > out.txt'] })
      )
      expect(output).toBe('v2')
    })

    itExceptWindows('rebuilds a dependant when its dependency env changes', async () => {
      const output = await consumeAfterChange(
        'invalidation-dep-env',
        buildFile({ envs: { MODE: 'dev' }, cmds: ['echo $MODE > out.txt'] }),
        buildFile({ envs: { MODE: 'prod' }, cmds: ['echo $MODE > out.txt'] })
      )
      expect(output).toBe('prod')
    })
  })

  describe('outputs', () => {
    itExceptWindows('recreates a deleted output instead of reporting the task as cached', async () => {
      await createTestCase('invalidation-deleted-output', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: { build: { src: ['in.txt'], generates: ['dist'], cmds: ['mkdir -p dist', 'cp in.txt dist/app.js'] } },
        },
        'in.txt': 'app',
      }).setup(async (cwd, environment) => {
        const run = async () => {
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
          expect((await cli.runExec()).success).toBe(true)
        }
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
        await cli.clean({ cache: true })
        await run()
        rmSync(join(cwd, 'dist'), { recursive: true })
        await run()
        expect(existsSync(join(cwd, 'dist/app.js'))).toBe(true)
      })
    })
  })

  describe('cache methods', () => {
    function project(tasks: { [name: string]: any }) {
      return {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': { tasks },
        'in.txt': 'in\n',
        'dep.txt': 'dep\n',
      }
    }

    // run once, apply the change, then ask whether the task is still cached
    async function cachedAfter(
      name: string,
      tasks: { [name: string]: any },
      change: (cwd: string) => void,
      cacheDefault: CacheMethod = 'checksum'
    ): Promise<boolean> {
      let cached = false
      await createTestCase(name, project(tasks)).setup(async (cwd, environment) => {
        const first = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 't' })
        await first.clean({ cache: true })
        expect((await first.runExec({ cacheDefault })).success).toBe(true)
        change(cwd)
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 't' })
        cached = (await checkCacheState(cli.task('t'), cacheDefault, environment)).cached
      })
      return cached
    }

    const unchanged = () => undefined
    const touch = (cwd: string) => utimesSync(join(cwd, 'in.txt'), new Date(2001, 1, 1), new Date(2001, 1, 1))

    itExceptWindows('never serves a task declaring cache: none from the cache', async () => {
      const tasks = { t: { cache: 'none', src: ['in.txt'], cmds: ['echo t'] } }
      expect(await cachedAfter('invalidation-cache-none', tasks, unchanged)).toBe(false)
    })

    itExceptWindows('never serves a task from the cache under --cache none', async () => {
      const tasks = { t: { src: ['in.txt'], cmds: ['echo t'] } }
      expect(await cachedAfter('invalidation-default-none', tasks, unchanged, 'none')).toBe(false)
    })

    itExceptWindows('honours a declared modify-date method over the checksum default', async () => {
      const tasks = { t: { cache: 'modify-date', src: ['in.txt'], cmds: ['echo t'] } }
      expect(await cachedAfter('invalidation-declared-mtime', tasks, touch)).toBe(false)
    })

    itExceptWindows('lets the sources of a cache: none dependency invalidate its dependants', async () => {
      const tasks = {
        dep: { cache: 'none', src: ['dep.txt'], cmds: ['echo dep'] },
        t: { deps: ['dep'], src: ['in.txt'], cmds: ['echo t'] },
      }
      const change = (cwd: string) => writeFileSync(join(cwd, 'dep.txt'), 'dep v2\n')
      expect(await cachedAfter('invalidation-none-dep', tasks, change)).toBe(false)
    })
  })
})
