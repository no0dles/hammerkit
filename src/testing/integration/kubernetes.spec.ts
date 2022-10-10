import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'

describe('kubernetes', () => {
  const suite = getTestSuite('kubernetes', ['index.js', 'package.json', 'package-lock.json', 'build.yaml'])

  afterAll(() => suite.close())

  it('should forward deployment', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'api' })
    expectSuccessfulResult(result)
  })
})
