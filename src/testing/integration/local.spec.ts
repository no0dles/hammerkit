import { expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'

describe('local', () => {
  const suite = getTestSuite('local', ['build.yaml'])

  afterAll(() => suite.close())

  it('should run local task', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
  })
})
