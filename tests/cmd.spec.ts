import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { expectContainsLog, expectLog, expectSuccessfulResult, getTestSuite } from './run-arg'

describe('cmd', () => {
  const suite = getTestSuite('cmd', ['build.yaml', 'sub/README.md'])

  afterAll(() => suite.close())

  it('should run with path arg', async () => {
    const { buildFile, executionContext } = await suite.setup()

    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectContainsLog(result, `${buildFile.path}:example`, 'README.md')
  })
})
