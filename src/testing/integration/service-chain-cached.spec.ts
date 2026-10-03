import { join } from 'path'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'

// A service that only another service needs (api -> db) must not keep a fully
// cached run waiting: api isn't started, and db has to see that.
describe('service needed only by a service', () => {
  it(
    'finishes a cached run without starting either service',
    requiresLinuxContainers(async () => {
      await createTestCase('service-chain-cached', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: {
            db: { image: 'alpine:3.19', cmd: 'sleep 600', healthcheck: { cmd: 'true' } },
            api: { image: 'alpine:3.19', cmd: 'sleep 600', needs: ['db'], healthcheck: { cmd: 'true' } },
          },
          tasks: {
            test: { image: 'alpine:3.19', needs: ['api'], src: ['in.txt'], cmds: ['cat in.txt'] },
          },
        },
        'in.txt': 'hello\n',
      }).setup(async (cwd, environment) => {
        const buildFile = join(cwd, '.hammerkit.yaml')
        const first = await createCli(buildFile, environment, { taskName: 'test' })
        await first.clean({ cache: true })
        expect((await first.runExec()).success).toBe(true)

        const second = await createCli(buildFile, environment, { taskName: 'test' })
        const result = await second.runExec()
        expect(result.success).toBe(true)
        expect(result.state.services['api'].state.current).toMatchObject({ type: 'end', reason: 'not-started' })
        expect(result.state.services['db'].state.current).toMatchObject({ type: 'end', reason: 'not-started' })
      })
    })
  )
})
