import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'

// A service's dependency runs once the service starts: when the task needing
// the service is a cache hit, the service never starts and its dependency
// (resetting the service's data, say) is skipped too.
describe('service dependencies', () => {
  it(
    'skips the dependency of a service that does not start',
    requiresLinuxContainers(async () => {
      await createTestCase('service-deps-skip', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: {
            db: { image: 'alpine:3.19', cmd: 'sleep 300', deps: ['reset'] },
          },
          tasks: {
            reset: { cmds: ['echo reset >> runs.log'] },
            test: { image: 'alpine:3.19', needs: ['db'], src: ['t.txt'], cmds: ['cat t.txt'] },
          },
        },
        't.txt': 'hello\n',
      }).setup(async (cwd, environment) => {
        const runs = () => (existsSync(join(cwd, 'runs.log')) ? readFileSync(join(cwd, 'runs.log'), 'utf8') : '')
        const first = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
        await first.clean({ cache: true })
        expect((await first.runExec()).success).toBe(true)
        expect(runs()).toEqual('reset\n')

        const second = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test' })
        const result = await second.runExec()
        expect(result.success).toBe(true)
        expect(result.state.tasks['test'].state.current).toMatchObject({ type: 'completed', cached: true })
        expect(result.state.tasks['reset'].state.current).toMatchObject({ type: 'completed', skipped: true })
        expect(result.state.services['db'].state.current).toMatchObject({ type: 'end', reason: 'not-started' })
        expect(runs()).toEqual('reset\n')
      })
    }),
    120000
  )
})
