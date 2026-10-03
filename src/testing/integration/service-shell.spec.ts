import { expectContainsLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { testingTimeout } from '../testing-timeout'

describe('service shell', () => {
  const suite = getTestSuite('service-shell', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it(
    'runs the service command and healthcheck through the shell',
    requiresLinuxContainers(async () => {
      const { cli, environment } = await suite.setup({ taskName: 'fetch' })
      const result = await testingTimeout(cli.exec(), 120000)
      await expectSuccessfulResult(result, environment)
      await expectContainsLog(result, environment, 'fetch', 'ready on Linux')
    }),
    300000
  )
})
