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

  // Outputs start empty when a task runs. A dependent's paused container still
  // mounts the volume, so it has to be emptied in place, not recreated.
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
