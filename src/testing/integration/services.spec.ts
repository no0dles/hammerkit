import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'

describe('services', () => {
  const suite = getTestSuite('services', ['index.js', 'package.json', 'package-lock.json', 'build.yaml'])

  afterAll(() => suite.close())

  it('should run service', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'api' })
    await expectSuccessfulResult(result)
  }, 120000)
})
