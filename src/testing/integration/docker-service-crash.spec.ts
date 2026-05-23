import { createTestCase } from '../test-case'
import { requiresLinuxContainers } from '../requires-linux-containers'

/**
 * Regression for the crash detection in docker-service.ts: a container that
 * exits while the runtime is waiting on abort must surface as
 * `{ type: 'end', reason: 'crash' }` instead of being silently 'terminated'.
 */
describe('docker service crash detection', () => {
  const testCase = createTestCase('docker-service-crash', {
    '.hammerkit.yaml': {
      services: {
        flaky: {
          image: 'alpine:3.19',
          // command exits with non-zero after a short delay
          cmd: 'sh -c "sleep 1 && exit 17"',
          ports: [':9000'],
        },
      },
    },
  })

  it(
    'reports crash when the container exits while running',
    requiresLinuxContainers(async () => {
      await testCase.cli({}, async (cli) => {
        // daemon=false so docker-service.ts awaits container.wait() instead of
        // returning as soon as the service is 'running'
        await cli.runUp({ daemon: false })

        const service = cli.service('flaky')
        expect(service.state.current.type).toBe('end')
        if (service.state.current.type === 'end') {
          expect(service.state.current.reason).toBe('crash')
        }
      })
    }),
    90000
  )
})
