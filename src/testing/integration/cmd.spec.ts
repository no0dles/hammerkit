import { expectContainsLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'

describe('cmd', () => {
  const suite = getTestSuite('cmd', ['.hammerkit.yaml', 'sub/README.md'])

  afterAll(() => suite.close())

  it('should run with path arg', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
    await expectContainsLog(result, environment, `example`, 'README.md')
  })
})
