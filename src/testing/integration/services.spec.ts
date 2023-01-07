import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'

describe('services', () => {
  const suite = getTestSuite('services', [
    'index.js',
    'server.js',
    'config.json',
    'package.json',
    'package-lock.json',
    '.hammerkit.yaml',
  ])

  afterAll(() => suite.close())

  it('should run with needed service', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'api' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
  }, 120000)

  it('should start needs of service', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'test' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
  }, 120000)
})
