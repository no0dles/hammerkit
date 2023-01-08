import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'

describe('kubernetes', () => {
  const suite = getTestSuite('kubernetes', ['index.js', 'package.json', 'package-lock.json', '.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should', () => {
    expect(true).toBeTrue()
  })

  // CI setup missing
  xit('should forward deployment', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'api' })
    const result = await cli.runExec()
    expectSuccessfulResult(result, environment)
  })
})
