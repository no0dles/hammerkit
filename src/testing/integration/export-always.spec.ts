import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'

// A failing test task still hands its report to CI: `export: always` outputs
// are copied to the host when the task fails, plain exports only on success.
describe('export always', () => {
  it(
    'copies export: always outputs of a failing task to the host',
    requiresLinuxContainers(async () => {
      await createTestCase('export-always', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          tasks: {
            test: {
              image: 'alpine:3.19',
              src: ['in.txt'],
              generates: [
                { path: 'report', export: 'always' },
                { path: 'dist', export: true },
              ],
              cmds: ['mkdir -p report dist', 'echo failed > report/result.txt', 'echo built > dist/app.txt', 'exit 3'],
            },
          },
        },
        'in.txt': 'hello\n',
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
        await cli.clean({ cache: true })
        const result = await cli.runExec()
        expect(result.success).toBe(false)
        expect(result.state.tasks['test'].state.current).toMatchObject({ type: 'crash', exitCode: 3 })
        expect(readFileSync(join(cwd, 'report', 'result.txt'), 'utf8')).toEqual('failed\n')
        expect(existsSync(join(cwd, 'dist', 'app.txt'))).toBe(false)
      })
    }),
    120000
  )
})
