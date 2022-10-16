import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'

describe('services', () => {
  const suite = getTestSuite('services', ['index.js', 'config.json', 'package.json', 'package-lock.json', 'build.yaml'])

  afterAll(() => suite.close())

  it('should run service', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'api' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
  }, 120000)
})
