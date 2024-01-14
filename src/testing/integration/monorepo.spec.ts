import { expectSuccessfulExecution } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { requiresLinuxContainers } from '../requires-linux-containers'

describe('monorepo', () => {
  const suite = getTestSuite('monorepo', ['.hammerkit.yaml', 'projects', 'build.npm.yaml', 'build.tsc.yaml'])

  afterAll(() => suite.close())

  it('should build and clean monorepo',  requiresLinuxContainers (async () => {
    const { cli, environment } = await suite.setup({ taskName: 'build' })
    await expectSuccessfulExecution(cli.exec(), environment)
    await cli.clean()
  }), 120000)
})
