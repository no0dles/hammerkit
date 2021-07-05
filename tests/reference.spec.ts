import {expectLog, expectSuccessfulResult, getTestSuite} from './run-arg';
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { planWorkNodes } from '../src/planner/utils/plan-work-nodes'

describe('reference', () => {
  const suite = getTestSuite('reference', ['build.yaml', 'foo'])

  afterAll(() => suite.close())

  it('should run included task', async () => {
    const {buildFile, executionContext} = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}/foo:bar`, 'info: foobar')
    await expectLog(result, `${buildFile.path}:example`,'info: hammertime')
  })

  it('should list task with references tasks nested', async () => {
    const {buildFile} = await suite.setup()
    const node = planWorkNodes(buildFile)
    expect(Object.keys(node).map((t) => node[t].name)).toEqual(['example', 'foo:bar', 'foo:sub:sub'])
  })
})
