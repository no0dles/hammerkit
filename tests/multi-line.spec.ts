import { loadExampleBuildFile } from './run-arg'

describe('multi-line', () => {
  const buildFile = loadExampleBuildFile('multi-line')

  it('should get multi lines', async () => {
    const task = buildFile.tasks['example']
    expect(task.cmds || []).toEqual(['some very long cmd continues on line 2', 'some other very long cmd continues on line 2'])
    expect(task.description).toEqual('Test multiline description')
  })
})
