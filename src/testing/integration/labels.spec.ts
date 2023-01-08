import { getTestSuite } from '../get-test-suite'
import { CliItem } from '../../cli'

describe('local', () => {
  const suite = getTestSuite('labels', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should run only run labeled task with app=bar and dependencies', async () => {
    const { cli } = await suite.setup({
      filterLabels: { app: ['bar'] },
      excludeLabels: {},
      mode: 'all',
    })
    expectNodes(cli.ls(), ['bar', 'base'])
  })

  it('should not run labeled task with app=foo and dependencies', async () => {
    const { cli } = await suite.setup({
      filterLabels: { app: ['foo'] },
      excludeLabels: {},
      mode: 'all',
    })
    expectNodes(cli.ls(), ['foo', 'base'])
  })

  it('should exclude foo labeled nodes', async () => {
    const { cli } = await suite.setup({
      filterLabels: {},
      excludeLabels: { app: ['foo'] },
      mode: 'all',
    })
    expectNodes(cli.ls(), ['bar', 'base'])
  })

  it('should exclude base labeled nodes', async () => {
    const { cli } = await suite.setup({
      filterLabels: {},
      excludeLabels: { app: ['base'] },
      mode: 'all',
    })
    expectNodes(cli.ls(), [])
  })

  it('should run nodes with label app=bar or app=foo', async () => {
    const { cli } = await suite.setup({
      filterLabels: { app: ['foo', 'bar'] },
      excludeLabels: {},
      mode: 'all',
    })
    expectNodes(cli.ls(), ['foo', 'bar', 'base'])
  })
})

function expectNodes(nodes: CliItem[], expectedNodes: string[]) {
  const nodeNames = Object.values(nodes).map((n) => n.item.name)
  expect(nodeNames).toIncludeSameMembers(expectedNodes)
}
