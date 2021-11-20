import { expectLog, expectSuccessfulResult } from '../expect'
import { planWorkNodes } from '../../planner/utils/plan-work-nodes'
import { getTestSuite } from '../get-test-suite'

describe('reference', () => {
  const suite = getTestSuite('reference', ['build.yaml', 'foo'])

  afterAll(() => suite.close())

  it('should run included task', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec('example')
    await expectSuccessfulResult(result)
    await expectLog(result, `foo:bar`, 'foobar')
    await expectLog(result, `example`, 'hammertime')
  })

  it('should list task with references tasks nested', async () => {
    const { buildFile } = await suite.setup()
    const [nodes] = planWorkNodes(buildFile)
    expect(Object.values(nodes).map((t) => t.name)).toEqual(['example', 'foo:bar', 'foo:sub:sub'])
  })
})
