import { expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'

describe('local', () => {
  const suite = getTestSuite('local', ['build.yaml'])

  afterAll(() => suite.close())

  it('should run local task', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'example' })
    await expectSuccessfulResult(result)
  })
})
