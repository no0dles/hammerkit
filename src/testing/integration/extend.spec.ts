import { getTestSuite } from '../get-test-suite'

describe('extend', () => {
  const suite = getTestSuite('extend', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should merge env variables', async () => {
    const { cli } = await suite.setup({ taskName: 'extend_env' })
    const task = await cli.task('extend_env')
    expect(task.data.envs.variables).toContainEntries([
      ['NAME', 'base'],
      ['KEEP', 'value'],
    ])
  })

  it('should extend and override', async () => {
    const { cli } = await suite.setup({ taskName: 'extend_container_task' })
    const task = await cli.task('extend_container_task')
    expect(task.data.envs.variables).toEqual({
      NAME: 'override',
    })
    expect(task.data.type).toBe('container-task')
    if (task.data.type === 'container-task') {
      expect(task.data.image).toBe('alpine:latest')
    }
  })

  it('should merge deps', async () => {
    const { cli } = await suite.setup({ taskName: 'extend_dep' })
    const task = await cli.task('extend_dep')
    expect(task.deps.map((d) => d.name)).toIncludeSameMembers(['base_env', 'extend_env'])
  })
})
