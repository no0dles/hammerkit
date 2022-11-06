import { getTestSuite } from '../get-test-suite'

describe('extend', () => {
  const suite = getTestSuite('extend', ['build.yaml'])

  afterAll(() => suite.close())

  it('should merge env variables', async () => {
    const { cli } = await suite.setup({ taskName: 'extend_env' })
    const node = await cli.node('extend_env')
    expect(node.envs).toContainEntries([
      ['NAME', 'base'],
      ['KEEP', 'value'],
    ])
  })

  it('should extend and override', async () => {
    const { cli } = await suite.setup({ taskName: 'extend_container_task' })
    const node = await cli.node('extend_container_task')
    expect(node.envs).toEqual({
      NAME: 'override',
    })
    expect(node.type).toBe('container')
    if (node.type === 'container') {
      expect(node.image).toBe('alpine')
    }
  })

  it('should merge deps', async () => {
    const { cli } = await suite.setup({ taskName: 'extend_dep' })
    const node = await cli.node('extend_dep')
    expect(node.deps.map((d) => d.name)).toIncludeSameMembers(['base_env', 'extend_env'])
  })
})
