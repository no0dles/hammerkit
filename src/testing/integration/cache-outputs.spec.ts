import { join } from 'path'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { listVolume } from '../read-volume'

// A cache hit must leave a container task's outputs where a later step reads
// them: exported directories and file outputs live on the host, not only in the
// task's docker volumes.
describe('container task outputs on a cache hit', () => {
  async function deleteAndRerun(
    name: string,
    generates: any[],
    cmds: string[],
    removed: string,
    output: string
  ): Promise<string> {
    let content = ''
    await createTestCase(name, {
      '.git/HEAD': 'ref: refs/heads/main\n',
      '.hammerkit.yaml': {
        tasks: { build: { image: 'alpine:3.19', src: ['in.txt'], generates, cmds } },
      },
      'in.txt': 'hello\n',
    }).setup(async (cwd, environment) => {
      const run = async () => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
        expect((await cli.runExec()).success).toBe(true)
      }
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
      await cli.clean({ cache: true })
      await run()
      rmSync(join(cwd, removed), { recursive: true })
      await run()
      content = existsSync(join(cwd, output)) ? readFileSync(join(cwd, output), 'utf8') : '<missing>'
    })
    return content
  }

  it(
    'brings back a deleted exported directory',
    requiresLinuxContainers(async () => {
      const content = await deleteAndRerun(
        'cache-outputs-export-dir',
        [{ path: 'dist', export: true }],
        ['mkdir -p dist', 'cp in.txt dist/app.txt'],
        'dist',
        'dist/app.txt'
      )
      expect(content).toBe('hello\n')
    })
  )

  it(
    'brings back a deleted file output',
    requiresLinuxContainers(async () => {
      const content = await deleteAndRerun(
        'cache-outputs-file',
        ['out.txt'],
        ['cat in.txt > out.txt'],
        'out.txt',
        'out.txt'
      )
      expect(content).toBe('hello\n')
    })
  )

  it(
    'brings back a file output whose folder is gone',
    requiresLinuxContainers(async () => {
      const content = await deleteAndRerun(
        'cache-outputs-file-folder',
        ['out/app.txt'],
        ['cat in.txt > out/app.txt'],
        'out',
        'out/app.txt'
      )
      expect(content).toBe('hello\n')
    })
  )

  // A forced rerun that fails leaves partial outputs in the task's volume and
  // exported directory. A later cache hit restores the earlier success, and must
  // restore exactly its outputs, not merge them into the leftovers.
  it(
    'replaces what a failed run left in the outputs',
    requiresLinuxContainers(async () => {
      await createTestCase('cache-outputs-failed-rerun', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            build: {
              image: 'alpine:3.19',
              src: ['in.txt'],
              // a mount is not part of the cache key, so the failing run has the success's key
              mounts: ['flags'],
              generates: [{ path: 'dist', export: true }, 'report'],
              cmds: [
                'mkdir -p dist report',
                'cp in.txt dist/app.txt',
                'cp in.txt report/r.txt',
                'if [ -f flags/fail ]; then touch dist/partial.txt report/partial.txt; exit 1; fi',
              ],
            },
          },
        },
        'in.txt': 'hello\n',
        'flags/.keep': '',
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'build' })
        const run = (options?: Parameters<typeof cli.runExec>[0]) => {
          environment.abortCtrl = new AbortController()
          return cli.runExec(options)
        }
        await cli.clean({ cache: true })
        expect((await run()).success).toBe(true)

        writeFileSync(join(cwd, 'flags', 'fail'), '')
        expect((await run({ cacheDefault: 'none' })).success).toBe(false)
        rmSync(join(cwd, 'flags', 'fail'))

        const result = await run()
        expect(result.success).toBe(true)
        expect(existsSync(join(cwd, 'dist', 'partial.txt'))).toBe(false)
        const report = result.state.tasks['build'].data.generates.find((g) => g.path.endsWith('report'))
        expect(await listVolume(report!.volumeName)).toEqual(['r.txt'])
      })
    })
  )

  // Outputs start empty when a task runs. Another container (a running
  // dependent's) may still mount the volume, so it is emptied in place, not recreated.
  it(
    'starts the outputs of a rerun empty',
    requiresLinuxContainers(async () => {
      await createTestCase('cache-outputs-reset-on-run', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            build: {
              image: 'alpine:3.19',
              src: ['in.txt'],
              generates: [{ path: 'dist', export: true }, 'report', { path: 'keep', resetOnChange: false }],
              cmds: [
                'mkdir -p dist report keep',
                'touch "dist/$(cat in.txt)" "report/$(cat in.txt)" "keep/$(cat in.txt)"',
              ],
            },
            check: { image: 'alpine:3.19', deps: ['build'], src: ['check.txt'], cmds: ['ls report'] },
          },
        },
        'in.txt': 'a\n',
        'check.txt': 'x\n',
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'check' })
        await cli.clean({ cache: true })
        expect((await cli.runExec()).success).toBe(true)

        writeFileSync(join(cwd, 'in.txt'), 'b\n')
        const result = await cli.runExec()
        expect(result.success).toBe(true)

        const volume = (name: string) =>
          result.state.tasks['build'].data.generates.find((g) => g.path.endsWith(name))!.volumeName
        expect(readdirSync(join(cwd, 'dist'))).toEqual(['b'])
        expect(await listVolume(volume('report'))).toEqual(['b'])
        expect((await listVolume(volume('keep'))).sort()).toEqual(['a', 'b'])
      })
    })
  )
})

// A file a container task generates is there for the container tasks that depend on it, as the
// digest of an image is for the task that deploys it.
describe('file outputs of a dependency', () => {
  it(
    'binds the file a dependency generates into the container of a task',
    requiresLinuxContainers(async () => {
      await createTestCase('file-output-of-dep', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            make: {
              image: 'alpine:3.19',
              src: ['in.txt'],
              generates: ['.out/value.txt'],
              cmds: ['cat in.txt > .out/value.txt'],
            },
            read: { image: 'alpine:3.19', deps: ['make'], cmds: ['test "$(cat .out/value.txt)" = hello'] },
          },
        },
        'in.txt': 'hello\n',
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'read' })
        await cli.clean({ cache: true })
        expect((await cli.runExec()).success).toBe(true)
      })
    })
  )

  // a folder a dependency generates that the task also lists in its src (a context a build
  // reads): the task sees the output, not the host's empty folder, and stays cached by it
  it(
    'shows a folder of a dependency that the task lists in its src, and keeps the task cached',
    requiresLinuxContainers(async () => {
      await createTestCase('folder-output-in-src', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            make: {
              image: 'alpine:3.19',
              src: ['in.txt'],
              generates: ['ctx'],
              cmds: ['mkdir -p ctx', 'cat in.txt > ctx/value'],
            },
            read: {
              image: 'alpine:3.19',
              deps: ['make'],
              src: ['ctx'],
              generates: ['out'],
              cmds: ['test "$(cat ctx/value)" = hello', 'mkdir -p out', 'cp ctx/value out/value'],
            },
          },
        },
        'in.txt': 'hello\n',
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'read' })
        await cli.clean({ cache: true })
        // the src stays the task's own, so its id and cache key are as before
        expect(cli.task('read').data.src.map((src) => [src.source, !!src.inherited])).toContainEqual(['ctx', false])
        const first = await cli.runExec()
        expect(first.success).toBe(true)
        const again = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'read' })
        const second = await again.runExec()
        expect(second.success).toBe(true)
        expect(second.state.tasks['read'].state.current).toMatchObject({ type: 'completed', cached: true })
      })
    })
  )
})
