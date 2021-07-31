import { expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'

describe('local', () => {
  const suite = getTestSuite('local', ['build.yaml'])

  afterAll(() => suite.close())

  it('should run local task', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
  })
})
