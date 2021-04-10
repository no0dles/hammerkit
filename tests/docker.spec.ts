import { expectLog, getTestArg, loadExampleBuildFile } from './run-arg'

describe('docker', () => {
  const buildFile = loadExampleBuildFile('docker')

  it('should pull docker image', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expectLog(mock, '6.14.11')
    expectLog(mock, 'v14.16.0')
  })
})
