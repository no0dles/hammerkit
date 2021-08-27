import { expectLog, expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { planWorkNodes } from '../../planner/utils/plan-work-nodes'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'

describe('reference', () => {
  const suite = getTestSuite('reference', ['build.yaml', 'foo'])

  afterAll(() => suite.close())

  it('should run included task', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectLog(result, `foo:bar`, 'foobar')
    await expectLog(result, `example`, 'hammertime')
  })

  it('should list task with references tasks nested', async () => {
    const { buildFile } = await suite.setup()
    const node = planWorkNodes(buildFile)
    expect(Object.values(node).map((t) => t.name)).toEqual(['example', 'foo:bar', 'foo:sub:sub'])
  })
})
