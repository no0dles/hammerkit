import { expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'

describe('monorepo', () => {
  const suite = getTestSuite('monorepo', ['build.yaml', 'projects', 'build.npm.yaml', 'build.tsc.yaml'])

  afterAll(() => suite.close())

  it('should build and clean monorepo', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'build' })
    await expectSuccessfulResult(result)
    await testCase.clean()
  }, 120000)
})
