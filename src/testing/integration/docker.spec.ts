import { expectLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'

describe('docker', () => {
  const suite = getTestSuite('docker', ['build.yaml'])

  afterAll(() => suite.close())

  it('should pull docker image', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec('example')
    await expectSuccessfulResult(result)
    await expectLog(result, `example`, '7.19.1')
    await expectLog(result, `example`, 'v16.6.0')
  })
})
