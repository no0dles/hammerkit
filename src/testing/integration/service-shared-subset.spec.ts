import { join } from 'path'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'

// Two targets share a db; running one of them must not wait for the other
// target's services and tasks, which aren't part of the run.
describe('a shared service in a run of one target', () => {
  it(
    'stops the services and finishes when only one target runs',
    requiresLinuxContainers(async () => {
      const service = (needs: string[]) => ({
        image: 'alpine:3.19',
        cmd: 'sleep 600',
        needs,
        healthcheck: { cmd: 'true' },
      })
      await createTestCase('service-shared-subset', {
        '.git/HEAD': 'ref: refs/heads/main\n',
        '.hammerkit.yaml': {
          services: { db: service([]), 'api-a': service(['db']), 'api-b': service(['db']) },
          tasks: {
            'test-a': { image: 'alpine:3.19', needs: ['api-a'], src: ['in.txt'], cmds: ['cat in.txt'] },
            'test-b': { image: 'alpine:3.19', needs: ['api-b'], src: ['in.txt'], cmds: ['cat in.txt'] },
          },
        },
        'in.txt': 'hello\n',
      }).setup(async (cwd, environment) => {
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'test-a' })
        await cli.clean({ cache: true })
        const result = await cli.runExec()
        expect(result.success).toBe(true)
        expect(result.state.services['db'].state.current.type).toBe('end')
        expect(result.state.services['api-b']).toBeUndefined()
      })
    }),
    60000
  )
})
