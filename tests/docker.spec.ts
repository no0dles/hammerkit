import { expectLog, expectSuccessfulResult, getTestSuite } from './run-arg'
import { execute } from '../src/executer/execute'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'

describe('docker', () => {
  const suite = getTestSuite('docker', ['build.yaml'])

  afterAll(() => suite.close())

  it('should pull docker image', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:example`, '6.14.11')
    await expectLog(result, `${buildFile.path}:example`, 'v14.16.0')
  })
})
