import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'
import { testingTimeout } from '../testing-timeout'
import { requiresLinuxContainers } from '../requires-linux-containers'

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

  it('should run with needed service',  requiresLinuxContainers (async () => {
    const { cli, environment } = await suite.setup({})
    const result = await testingTimeout(cli.up({ daemon: true }), 120000)
    await expectSuccessfulResult(result, environment)
  }), 120000)

  it('should start needs of service',  requiresLinuxContainers (async () => {
    const { cli, environment } = await suite.setup({ taskName: 'test' })
    const result = await testingTimeout(cli.exec(), 120000)
    await expectSuccessfulResult(result, environment)
  }), 120000)

  it('should start services up',  requiresLinuxContainers (async () => {
    const { cli } = await suite.setup({
      filterLabels: { task: ['dev'] },
      excludeLabels: {},
    })
    const upResult = await testingTimeout(cli.up({ daemon: true }))
    expect(upResult.success).toBeTrue()
    const downResult = await cli.runDown()
    expect(downResult.success).toBeTrue()
  }), 120000)
})
