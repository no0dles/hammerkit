import { getTestSuite } from '../get-test-suite'

describe('extend', () => {
  const suite = getTestSuite('extend', ['build.yaml'])

  afterAll(() => suite.close())

  it('should merge env variables', async () => {
    const testCase = await suite.setup()
    const node = await testCase.getNode('extend_env')
    expect(node.envs).toEqual({
      NAME: 'base',
      KEEP: 'value',
    })
  })

  it('should extend and override', async () => {
    const testCase = await suite.setup()
    const node = await testCase.getNode('extend_container_task')
    expect(node.envs).toEqual({
      NAME: 'override',
    })
    expect(node.type).toBe('container')
    if (node.type === 'container') {
      expect(node.image).toBe('alpine')
    }
  })

  it('should merge deps', async () => {
    const testCase = await suite.setup()
    const node = await testCase.getNode('extend_dep')
    expect(node.deps.map((d) => d.name)).toIncludeSameMembers(['base_env', 'extend_env'])
  })
})
