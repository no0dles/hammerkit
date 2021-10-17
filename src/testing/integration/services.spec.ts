import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { expectSuccessfulResult } from '../expect'

describe('services', () => {
  const suite = getTestSuite('services', ['index.js', 'package.json', 'package-lock.json', 'build.yaml'])

  afterAll(() => suite.close())

  it('should run service', async () => {
    const { buildFile, executionContext, context } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'api')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
  }, 120000)
})
