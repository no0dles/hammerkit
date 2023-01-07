import { getTestSuite } from '../get-test-suite'

describe('invalid', () => {
  const suite = getTestSuite('invalid_loop', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should detect loop in execution', async () => {
    const { cli } = await suite.setup({ taskName: 'foo' })
    const result = await cli.exec()
    expect(result.success).toBeFalsy()
  })

  it('should detect loop in services', async () => {
    const { cli } = await suite.setup({ taskName: 'loopservice' })
    const result = await cli.exec()
    expect(result.success).toBeFalsy()
  })
})
