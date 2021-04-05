import { getTestArg, loadExampleBuildFile } from './run-arg'

describe('env', () => {
  const buildFile = loadExampleBuildFile('env')

  it('should use env from build file', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expect(mock.mock.calls.length).toBe(2)
    expect(mock.mock.calls[0][0]).toEqual('14.16.0')
    expect(mock.mock.calls[1][0]).toEqual('echo 14.16.0')
  })

  it('should pass env to docker', async () => {
    const exampleTask = buildFile.getTask('example_docker')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expect(mock.mock.calls.length).toBe(2)
    expect(mock.mock.calls[mock.mock.calls.length - 2][0]).toEqual('pull alpine')
    expect(mock.mock.calls[mock.mock.calls.length - 1][0]).toEqual('14.16.0')
  })

  it('should use env from task', async () => {
    const exampleTask = buildFile.getTask('example_override')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expect(mock.mock.calls.length).toBe(2)
    expect(mock.mock.calls[0][0]).toEqual('15.0.0')
    expect(mock.mock.calls[1][0]).toEqual('echo 15.0.0')
  })

  it('should use env from .env', async () => {
    const exampleTask = buildFile.getTask('example_with_dotenv')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expect(mock.mock.calls.length).toBe(2)
    expect(mock.mock.calls[0][0]).toEqual('123456')
    expect(mock.mock.calls[1][0]).toEqual('echo 123456')
  })

  it('should use process env', async () => {
    const exampleTask = buildFile.getTask('example_with_shell_env')
    const [arg, mock] = getTestArg()
    arg.envs.processEnvs['VERSION'] = '1.0.0'
    await exampleTask.execute(arg)
    expect(mock.mock.calls[0][0]).toEqual('1.0.0')
    expect(mock.mock.calls[1][0]).toEqual('echo 1.0.0')
  })

  it('should throw if process env is missing', async () => {
    const exampleTask = buildFile.getTask('example_with_shell_env')
    const [arg] = getTestArg()
    await expect(exampleTask.execute(arg)).rejects.toEqual(new Error('missing env $VERSION'))
  })
})
