import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { expectLog, expectSuccessfulResult, getTestSuite } from './run-arg'

describe('include', () => {
  const suite = getTestSuite('include', ['build.yaml', 'foo', 'foobar.txt'])

  afterAll(() => suite.close())

  it('should run included task', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:foo:bar`, 'info: foobar')
  })

  it('should get name:example', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'name:example')
    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result)
  })

  it('should get included task', async () => {
    const { buildFile } = await suite.setup()
    const tree = planWorkTree(buildFile, 'foo:bar')
    expect(tree.rootNode.name).toEqual('foo:bar')
    expect(tree.rootNode.cwd).toEqual(buildFile.path)
  })
})
