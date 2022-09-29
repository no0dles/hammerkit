import { expectLog, expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { getTestSuite } from '../get-test-suite'

describe('include', () => {
  const suite = getTestSuite('include', ['build.yaml', 'foo', 'foobar.txt'])

  afterAll(() => suite.close())

  it('should run included task', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'example' })
    await expectSuccessfulResult(result)
    await expectLog(result, `foo:bar`, 'foobar')
  })

  it('should get name:example', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'name:example' })
    await expectSuccessfulResult(result)
  })

  it('should get included task', async () => {
    const { buildFile } = await suite.setup()
    const tree = planWorkTree(buildFile, { taskName: 'foo:bar' })
    expect(tree.rootNode?.name).toEqual('foo:bar')
    expect(tree.rootNode?.cwd).toEqual(buildFile.path)
  })
})
