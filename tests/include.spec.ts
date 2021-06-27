import { expectLog, getTestArg, loadExampleBuildFile } from './run-arg'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'

describe('include', () => {
  const buildFile = loadExampleBuildFile('include')

  it('should run included task', async () => {
    const [arg, mock] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example')
    await execute(workTree, arg)
    expectLog(mock, 'foobar')
    expectLog(mock, 'cat foobar.txt')
  })

  it('should get name:example', async () => {
    const [arg] = getTestArg()
    const workTree = planWorkTree(buildFile, 'name:example')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
  })

  it('should get included task', async () => {
    const tree = planWorkTree(buildFile, 'foo:bar')
    expect(tree.rootNode.name).toEqual('foo:bar')
    expect(tree.rootNode.path).toEqual(buildFile.path)
  })
})
