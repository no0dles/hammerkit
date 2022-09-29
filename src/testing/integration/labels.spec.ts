import { getTestSuite } from '../get-test-suite'
import { planWorkNodes } from '../../planner/utils/plan-work-nodes'
import { WorkNodes } from '../../planner/work-nodes'
import { WorkServices } from '../../planner/work-services'

describe('local', () => {
  const suite = getTestSuite('labels', ['build.yaml'])

  afterAll(() => suite.close())

  it('should run only run labeled task with app=bar and dependencies', async () => {
    const testCase = await suite.setup()
    const plan = planWorkNodes(testCase.buildFile, { filterLabels: { app: ['bar'] }, excludeLabels: {} })
    expectNodes(plan, ['bar', 'base'])
  })

  it('should not run labeled task with app=foo and dependencies', async () => {
    const testCase = await suite.setup()
    const plan = planWorkNodes(testCase.buildFile, { filterLabels: { app: ['foo'] }, excludeLabels: {} })
    expectNodes(plan, ['foo', 'base'])
  })

  it('should exclude foo labeled nodes', async () => {
    const testCase = await suite.setup()
    const plan = planWorkNodes(testCase.buildFile, { filterLabels: {}, excludeLabels: { app: ['foo'] } })
    expectNodes(plan, ['bar', 'base'])
  })

  it('should exclude base labeled nodes', async () => {
    const testCase = await suite.setup()
    const plan = planWorkNodes(testCase.buildFile, { filterLabels: {}, excludeLabels: { app: ['base'] } })
    expectNodes(plan, [])
  })

  it('should run nodes with label app=bar or app=foo', async () => {
    const testCase = await suite.setup()
    const plan = planWorkNodes(testCase.buildFile, { filterLabels: { app: ['foo', 'bar'] }, excludeLabels: {} })
    expectNodes(plan, ['foo', 'bar', 'base'])
  })
})

function expectNodes(plan: [WorkNodes, WorkServices], expectedNodes: string[]) {
  const nodes = plan[0]
  const nodeNames = Object.values(nodes).map((n) => n.name)
  expect(nodeNames).toIncludeSameMembers(expectedNodes)
}
