import { getTestArg, loadExampleBuildFile } from './run-arg'

describe('docker', () => {
  const buildFile = loadExampleBuildFile('docker')

  it('should pull docker image', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expect(mock.mock.calls.length).toBe(4)
    expect(mock.mock.calls[1][0]).toEqual('6.14.11')
    expect(mock.mock.calls[3][0]).toEqual('v14.16.0')
  })
})
