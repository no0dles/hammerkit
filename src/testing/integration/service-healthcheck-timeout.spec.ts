import { getTestSuite } from '../get-test-suite'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { testingTimeout } from '../testing-timeout'

describe('service healthcheck timeout', () => {
  const suite = getTestSuite('service-healthcheck-timeout', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it(
    'fails the run when the healthcheck does not pass in time',
    requiresLinuxContainers(async () => {
      const { cli } = await suite.setup({ taskName: 'use' })
      const started = Date.now()
      const result = await testingTimeout(cli.exec(), 60000)
      expect(result.success).toBe(false)
      expect(Date.now() - started).toBeLessThan(45000)
      const service = Object.values(result.state.services).find((s) => s.name === 'never')
      expect(service?.state.current.type).toEqual('end')
      const messages = Array.from(service?.status.read() ?? []).map((log) => log.message)
      expect(
        messages.some((message) => message.includes('did not pass its healthcheck "test -f /ready" within 2s'))
      ).toBe(true)
    }),
    120000
  )
})
