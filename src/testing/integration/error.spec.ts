import { getTestSuite } from '../get-test-suite'

describe('error', () => {
  const suite = getTestSuite('error', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should return error when local task failed', async () => {
    const { cli } = await suite.setup({ taskName: 'local_error' })
    const result = await cli.exec()
    expect(result.success).toBeFalsy()
  })

  it('should return error when docker task failed', async () => {
    const { cli } = await suite.setup({ taskName: 'docker_error' })
    const result = await cli.exec()
    expect(result.success).toBeFalsy()
  })
})
