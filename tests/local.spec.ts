import { getTestArg, loadExampleBuildFile } from './run-arg'

describe('local', () => {
  const buildFile = loadExampleBuildFile('local')

  it('should run local task', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg] = getTestArg()
    await exampleTask.execute(arg)
  })
})
