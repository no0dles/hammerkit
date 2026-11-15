import Dockerode from 'dockerode'
import { expectContainsLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { testingTimeout } from '../testing-timeout'

describe('service healthcheck request', () => {
  const suite = getTestSuite('service-healthcheck-request', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  async function listCheckContainers() {
    return new Dockerode().listContainers({ all: true, filters: { label: ['hammerkit-type=healthcheck'] } })
  }

  it(
    'waits for http and tcp healthchecks of services without curl and without a published port',
    requiresLinuxContainers(async () => {
      const { cli, environment } = await suite.setup({ taskName: 'use' })
      const result = await testingTimeout(cli.exec(), 180000)
      await expectSuccessfulResult(result, environment)
      await expectContainsLog(result, environment, 'use', 'services ready')
      // the container of the checks goes once its service is up
      expect(await listCheckContainers()).toEqual([])
    }),
    300000
  )

  it(
    'fails a service whose http check never gets one of its status codes',
    requiresLinuxContainers(async () => {
      const { cli } = await suite.setup({ taskName: 'unreachable' })
      const result = await testingTimeout(cli.exec(), 120000)
      expect(result.success).toBe(false)
      const service = Object.values(result.state.services).find((s) => s.name === 'wrong')
      expect(service?.state.current.type).toEqual('end')
      const messages = Array.from(service?.status.read() ?? []).map((log) => log.message)
      expect(
        messages.some((message) =>
          message.includes('service wrong did not pass its healthcheck "GET http://:8000/ (204)" within 3s')
        )
      ).toBe(true)
      expect(await listCheckContainers()).toEqual([])
    }),
    180000
  )
})
