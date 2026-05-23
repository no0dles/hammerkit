import { getTestSuite } from '../get-test-suite'
import { requiresLinuxContainers } from '../requires-linux-containers'

describe('error', () => {
  const suite = getTestSuite('error', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should return error when local task failed', async () => {
    const { cli } = await suite.setup({ taskName: 'local_error' })
    const result = await cli.runExec()
    expect(result.success).toBeFalsy()
  })

  it('should return error when docker task failed',  requiresLinuxContainers (async () => {
    const { cli } = await suite.setup({ taskName: 'docker_error' })
    const result = await cli.runExec()
    expect(result.success).toBeFalsy()
  }))
})
