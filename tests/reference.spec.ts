import { expectLog, getTestArg, loadExampleBuildFile } from './run-arg'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { planWorkNodes } from '../src/planner/utils/plan-work-nodes'

describe('reference', () => {
  const buildFile = loadExampleBuildFile('reference')

  it('should run included task', async () => {
    const [arg, mock] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, 'foobar')
    expectLog(mock, 'cat foobar.txt')
    expectLog(mock, 'hammertime')
    expectLog(mock, 'echo hammertime')
  })

  it('should list task with references tasks nested', async () => {
    const node = planWorkNodes(buildFile)
    expect(Object.keys(node).map((t) => node[t].name)).toEqual(['example', 'foo:bar', 'foo:sub:sub'])
  })
})
