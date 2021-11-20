import { expectContainsLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'

describe('cmd', () => {
  const suite = getTestSuite('cmd', ['build.yaml', 'sub/README.md'])

  afterAll(() => suite.close())

  it('should run with path arg', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec('example')
    await expectSuccessfulResult(result)
    await expectContainsLog(result, `example`, 'README.md')
  })
})
