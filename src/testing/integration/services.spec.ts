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
    const { cli, environment } = await suite.setup({})
    const result = await cli.runUp({ daemon: true })
    await expectSuccessfulResult(result, environment)
  }, 120000)

  it('should start needs of service', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'test' })
    const result = await cli.runExec()
    await expectSuccessfulResult(result, environment)
  }, 120000)

  it('should start services up', async () => {
    const { cli } = await suite.setup({
      filterLabels: { task: ['dev'] },
      excludeLabels: {},
    })
    const upResult = await cli.runUp({ daemon: true })
    expect(upResult.success).toBeTrue()
    const downResult = await cli.runDown()
    expect(downResult.success).toBeTrue()
  }, 120000)
})
