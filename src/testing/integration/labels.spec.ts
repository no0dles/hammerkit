import { getTestSuite } from '../get-test-suite'
import { planWorkNodes } from '../../planner/utils/plan-work-nodes'
import { WorkTree } from '../../planner/work-tree'

describe('local', () => {
  const suite = getTestSuite('labels', ['build.yaml'])

  afterAll(() => suite.close())

  it('should run only run labeled task with app=bar and dependencies', async () => {
    const testCase = await suite.setup()
    const plan = planWorkNodes(testCase.buildFile, {
      filterLabels: { app: ['bar'] },
      excludeLabels: {},
      noContainer: false,
    })
    expectNodes(plan, ['bar', 'base'])
  })

  it('should not run labeled task with app=foo and dependencies', async () => {
    const testCase = await suite.setup()
    const plan = planWorkNodes(testCase.buildFile, {
      filterLabels: { app: ['foo'] },
      excludeLabels: {},
      noContainer: false,
    })
    expectNodes(plan, ['foo', 'base'])
  })

  it('should exclude foo labeled nodes', async () => {
    const testCase = await suite.setup()
    const plan = planWorkNodes(testCase.buildFile, {
      filterLabels: {},
      excludeLabels: { app: ['foo'] },
      noContainer: false,
    })
    expectNodes(plan, ['bar', 'base'])
  })

  it('should exclude base labeled nodes', async () => {
    const testCase = await suite.setup()
    const plan = planWorkNodes(testCase.buildFile, {
      filterLabels: {},
      excludeLabels: { app: ['base'] },
      noContainer: false,
    })
    expectNodes(plan, [])
  })

  it('should run nodes with label app=bar or app=foo', async () => {
    const testCase = await suite.setup()
    const plan = planWorkNodes(testCase.buildFile, {
      filterLabels: { app: ['foo', 'bar'] },
      excludeLabels: {},
      noContainer: false,
    })
    expectNodes(plan, ['foo', 'bar', 'base'])
  })
})

function expectNodes(plan: WorkTree, expectedNodes: string[]) {
  const nodeNames = Object.values(plan.nodes).map((n) => n.name)
  expect(nodeNames).toIncludeSameMembers(expectedNodes)
}
