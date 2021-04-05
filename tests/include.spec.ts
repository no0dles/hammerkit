import { getTestArg, loadExampleBuildFile } from './run-arg'

describe('include', () => {
  const buildFile = loadExampleBuildFile('include')

  it('should run included task', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expect(mock.mock.calls.length).toBe(2)
    expect(mock.mock.calls[0][0]).toEqual('foobar')
    expect(mock.mock.calls[1][0]).toEqual('cat foobar.txt')
  })
})
