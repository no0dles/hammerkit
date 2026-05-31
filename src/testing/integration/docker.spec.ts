import { expectLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { requiresLinuxContainers } from '../requires-linux-containers'

describe('docker', () => {
  const suite = getTestSuite('docker', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it(
    'should pull docker image',
    requiresLinuxContainers(async () => {
      const { cli, environment } = await suite.setup({ taskName: 'example' })
      const result = await cli.runExec()
      await expectSuccessfulResult(result, environment)
      // versions printed by the pinned node:24.16.0-alpine fixture image
      await expectLog(result, environment, `example`, '11.13.0')
      await expectLog(result, environment, `example`, 'v24.16.0')
    })
  )
})
