import { getTestSuite } from '../get-test-suite'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { execute } from '../../executer/execute'

describe('invalid', () => {
  const suite = getTestSuite('invalid_loop', ['build.yaml'])

  afterAll(() => suite.close())

  it('should detect loop in execution', async () => {
    const { buildFile, executionContext } = await suite.setup()

    const workTree = planWorkTree(buildFile, 'foo')
    const result = await execute(workTree, executionContext)
    expect(result.success).toBeFalsy()
  })
})
