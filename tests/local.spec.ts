import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { expectSuccessfulResult, getTestSuite } from './run-arg'

describe('local', () => {
  const suite = getTestSuite('local', ['build.yaml'])

  afterAll(() => suite.close())

  it('should run local task', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result)
  })
})
