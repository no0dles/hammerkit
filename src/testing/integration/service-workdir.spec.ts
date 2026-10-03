import { expectContainsLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { testingTimeout } from '../testing-timeout'

describe('service workdir', () => {
  const suite = getTestSuite('service-workdir', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it(
    'runs the service in its declared working directory',
    requiresLinuxContainers(async () => {
      const { cli, environment } = await suite.setup({ taskName: 'fetch' })
      const result = await testingTimeout(cli.exec(), 120000)
      await expectSuccessfulResult(result, environment)
      await expectContainsLog(result, environment, 'fetch', '3.')
    }),
    300000
  )
})
