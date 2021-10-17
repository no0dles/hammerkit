import { expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { clean } from '../../executer/clean'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'

describe('monorepo', () => {
  const suite = getTestSuite('monorepo', ['build.yaml', 'projects', 'build.npm.yaml', 'build.tsc.yaml'])

  afterAll(() => suite.close())

  it('should build and clean monorepo', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'build')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await clean(workTree.nodes, workTree.services, executionContext.environment, executionContext.executor)
  }, 120000)
})
