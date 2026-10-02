import { join } from 'path'
import { existsSync, readFileSync, rmSync } from 'fs'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'

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
})
