import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'

describe('kubernetes', () => {
  const suite = getTestSuite('kubernetes', ['index.js', 'package.json', 'package-lock.json', 'build.yaml'])

  afterAll(() => suite.close())

  // CI setup missing
  xit('should forward deployment', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'api' })
    const result = await cli.exec()
    expectSuccessfulResult(result, environment)
  })
})
