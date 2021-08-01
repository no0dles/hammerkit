import { expectLog, expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'

describe('docker', () => {
  const suite = getTestSuite('docker', ['build.yaml'])

  afterAll(() => suite.close())

  it('should pull docker image', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectLog(result, `example`, '6.14.11')
    await expectLog(result, `example`, 'v14.16.0')
  })
})
