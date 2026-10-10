import { expectContainsLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { testingTimeout } from '../testing-timeout'

describe('service healthcheck user', () => {
  const suite = getTestSuite('service-healthcheck-user', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it(
    'runs the healthcheck as the service process user',
    requiresLinuxContainers(async () => {
      const { cli, environment } = await suite.setup({ taskName: 'check' })
      const result = await testingTimeout(cli.exec(), 180000)
      await expectSuccessfulResult(result, environment)
      await expectContainsLog(result, environment, 'check', 'rabbitmq ready')
    }),
    300000
  )
})
