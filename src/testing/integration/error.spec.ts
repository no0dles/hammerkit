import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'

describe('error', () => {
  const suite = getTestSuite('error', ['build.yaml'])

  afterAll(() => suite.close())

  it('should return error when local task failed', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'local_error')
    const result = await execute(workTree, executionContext)
    expect(result.success).toBeFalsy()
  })

  it('should return error when docker task failed', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'docker_error')
    const result = await execute(workTree, executionContext)
    expect(result.success).toBeFalsy()
  })
})
