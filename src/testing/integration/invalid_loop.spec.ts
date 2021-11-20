import { getTestSuite } from '../get-test-suite'

describe('invalid', () => {
  const suite = getTestSuite('invalid_loop', ['build.yaml'])

  afterAll(() => suite.close())

  it('should detect loop in execution', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec('foo')
    expect(result.success).toBeFalsy()
  })
})
