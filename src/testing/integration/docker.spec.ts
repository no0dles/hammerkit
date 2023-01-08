import { expectLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'

describe('docker', () => {
  const suite = getTestSuite('docker', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should pull docker image', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example' })
    const result = await cli.runExec()
    await expectSuccessfulResult(result, environment)
    await expectLog(result, environment, `example`, '7.19.1')
    await expectLog(result, environment, `example`, 'v16.6.0')
  })
})
