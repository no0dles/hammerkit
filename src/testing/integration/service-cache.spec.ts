import { join } from 'path'
import { createTestCase } from '../test-case'
import { createCli } from '../../program'
import { requiresLinuxContainers } from '../requires-linux-containers'

// A task that needs a service (an e2e job needing a database) and is a cache hit
// must not start the service, and must not fail the run because the service
// never started. A service that cannot start must fail the run.

function project(serviceImage: string, localCache: string) {
  return {
    '.git/HEAD': 'ref: refs/heads/main\n',
    '.hammerkit.yaml': {
      caches: { default: { method: 'checksum', backend: { type: 'local', path: localCache } } },
      services: {
        db: {
          image: serviceImage,
          cmd: 'sleep 3600',
          ports: [':8080'],
          healthcheck: { cmd: 'true' },
        },
      },
      tasks: {
        e2e: {
          image: 'alpine:3.19',
          needs: ['db'],
          src: ['input.txt'],
          cmds: ['cat input.txt'],
        },
      },
    },
    'input.txt': 'hello\n',
  }
}

describe('services and the cache', () => {
  it(
    'succeeds without starting the service when the needing task is cached',
    requiresLinuxContainers(async () => {
      const localCache = join(process.cwd(), 'temp', 'service-cache-hit-local')
      await createTestCase('service-cache-hit', project('alpine:3.19', localCache)).setup(async (cwd, environment) => {
        await environment.file.remove(localCache)
        const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'e2e' })
        await cli.clean()

        const first = await cli.runExec()
        expect(first.success).toBe(true)
        expect(first.state.tasks['e2e'].state.current).toMatchObject({ type: 'completed', cached: false })

        const second = await cli.runExec()
        expect(second.state.tasks['e2e'].state.current).toMatchObject({ type: 'completed', cached: true })
        expect(second.state.services['db'].state.current.type).toBe('pending')
        expect(second.success).toBe(true)
      })
    })
  )

  it(
    'fails the run when a needed service cannot start',
    requiresLinuxContainers(async () => {
      const localCache = join(process.cwd(), 'temp', 'service-cache-broken-local')
      await createTestCase('service-cache-broken', project('hammerkit-does-not-exist:nope', localCache)).setup(
        async (cwd, environment) => {
          await environment.file.remove(localCache)
          const cli = await createCli(join(cwd, '.hammerkit.yaml'), environment, { taskName: 'e2e' })
          const result = await cli.runExec()
          // the docker runtime reports a service that failed to start as a crash
          expect(result.state.services['db'].state.current).toMatchObject({ type: 'end', reason: 'crash' })
          expect(result.state.tasks['e2e'].state.current).toMatchObject({
            type: 'error',
            errorMessage: 'needed service db stopped before it was ready',
          })
          expect(result.success).toBe(false)
        }
      )
    })
  )
})
