import { expectLog, expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'

describe('include', () => {
  const suite = getTestSuite('include', ['build.yaml', 'foo', 'foobar.txt'])

  afterAll(() => suite.close())

  it('should run included task', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectLog(result, `foo:bar`, 'foobar')
  })

  it('should get name:example', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'name:example')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
  })

  it('should get included task', async () => {
    const { buildFile } = await suite.setup()
    const tree = planWorkTree(buildFile, 'foo:bar')
    expect(tree.rootNode.name).toEqual('foo:bar')
    expect(tree.rootNode.cwd).toEqual(buildFile.path)
  })
})
