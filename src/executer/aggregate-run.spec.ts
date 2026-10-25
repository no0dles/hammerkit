import { join } from 'path'
import { createTestCase } from '../testing/test-case'
import { createCli } from '../program'
import { Environment } from './environment'

// Local task execution is not reliable on the Windows hosted runner (see
// execute.spec.ts), so gate these real runs off win32.
const itExceptWindows = process.platform === 'win32' ? it.skip : it

// the aggregate is in the root, what it groups in a reference, which runs in its own directory
function project(backendPath: string) {
  return {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      caches: { default: { method: 'checksum', backend: { type: 'local', path: backendPath } } },
      references: { lib: './lib/.hammerkit.yaml' },
      tasks: { all: { deps: ['lib:build'] } },
    },
    'lib/.hammerkit.yaml': {
      tasks: { build: { src: ['input.txt'], generates: ['out'], cmds: ['mkdir -p out', 'cp input.txt out/a.txt'] } },
    },
    'lib/input.txt': 'a\n',
  }
}

async function list(environment: Environment, path: string): Promise<string[]> {
  return (await environment.file.exists(path)) ? environment.file.listFiles(path) : []
}

describe('running an aggregate', () => {
  itExceptWindows('writes nothing to its directory and pushes nothing of its own', async () => {
    const backendPath = join(process.cwd(), 'temp', 'aggregate-run-backend')
    await createTestCase('aggregate-run', project(backendPath)).setup(async (cwd, environment) => {
      await environment.file.remove(backendPath)
      const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, {})
      await cli.clean({ cache: true })
      const first = await cli.runExec()
      expect(first.success).toBe(true)
      expect(first.state.tasks['all'].state.current).toMatchObject({ type: 'completed', cached: false })
      // no pid or state file: on a server its directory is a checkout it doesn't trust
      expect(await environment.file.exists(join(cwd, '.hammerkit'))).toBe(false)
      expect(await list(environment, backendPath)).toEqual([cli.task('lib:build').id()])

      const second = await cli.runExec()
      expect(second.state.tasks['all'].state.current).toMatchObject({ type: 'completed', cached: true })
      expect(await environment.file.exists(join(cwd, '.hammerkit'))).toBe(false)
    })
  })
})
