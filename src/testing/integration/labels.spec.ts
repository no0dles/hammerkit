import { getTestSuite } from '../get-test-suite'
import { CliItem } from '../../cli'

describe('local', () => {
  const suite = getTestSuite('labels', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should run only run labeled task with app=bar and dependencies', async () => {
    const { cli } = await suite.setup({
      filterLabels: { app: ['bar'] },
    })
    expectNodes(cli.ls(), ['bar', 'base'])
  })

  it('should not run labeled task with app=foo and dependencies', async () => {
    const { cli } = await suite.setup({
      filterLabels: { app: ['foo'] },
    })
    expectNodes(cli.ls(), ['foo', 'base'])
  })

  it('should exclude foo labeled tasks', async () => {
    const { cli } = await suite.setup({
      excludeLabels: { app: ['foo'] },
    })
    expectNodes(cli.ls(), ['bar', 'base'])
  })

  it('should exclude base labeled tasks', async () => {
    const { cli } = await suite.setup({
      excludeLabels: { app: ['base'] },
    })
    expectNodes(cli.ls(), [])
  })

  it('should run tasks with label app=bar or app=foo', async () => {
    const { cli } = await suite.setup({
      filterLabels: { app: ['foo', 'bar'] },
    })
    expectNodes(cli.ls(), ['foo', 'bar', 'base'])
  })
})

function expectNodes(items: CliItem[], expectedNames: string[]) {
  const itemNames = items.map((n) => n.item.name)
  expect(itemNames).toIncludeSameMembers(expectedNames)
}
