import { getTestSuite } from '../get-test-suite'

describe('extend', () => {
  const suite = getTestSuite('extend', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should merge env variables', async () => {
    const { cli } = await suite.setup({ taskName: 'extend_env' })
    const node = await cli.node('extend_env')
    expect(node.data.envs.variables).toContainEntries([
      ['NAME', 'base'],
      ['KEEP', 'value'],
    ])
  })

  it('should extend and override', async () => {
    const { cli } = await suite.setup({ taskName: 'extend_container_task' })
    const node = await cli.node('extend_container_task')
    expect(node.data.envs.variables).toEqual({
      NAME: 'override',
    })
    expect(node.data.type).toBe('container-task')
    if (node.data.type === 'container-task') {
      expect(node.data.image).toBe('alpine:latest')
    }
  })

  it('should merge deps', async () => {
    const { cli } = await suite.setup({ taskName: 'extend_dep' })
    const node = await cli.node('extend_dep')
    expect(node.deps.map((d) => d.name)).toIncludeSameMembers(['base_env', 'extend_env'])
  })
})
