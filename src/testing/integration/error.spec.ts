import { getTestSuite } from '../get-test-suite'

describe('error', () => {
  const suite = getTestSuite('error', ['build.yaml'])

  afterAll(() => suite.close())

  it('should return error when local task failed', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec('local_error')
    expect(result.success).toBeFalsy()
  })

  it('should return error when docker task failed', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec('docker_error')
    expect(result.success).toBeFalsy()
  })
})
