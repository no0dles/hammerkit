import { expectLog, getTestArg, loadExampleBuildFile } from './run-arg'

describe('env', () => {
  const buildFile = loadExampleBuildFile('env')

  it('should use env from build file', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg, [])
    expectLog(mock, '14.16.0')
    expectLog(mock, 'echo 14.16.0')
  })

  it('should pass env to docker', async () => {
    const exampleTask = buildFile.getTask('example_docker')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg, [])
    expectLog(mock, '14.16.0')
  })

  it('should use env from task', async () => {
    const exampleTask = buildFile.getTask('example_override')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg, [])
    expectLog(mock, '15.0.0')
    expectLog(mock, 'echo 15.0.0')
  })

  it('should use env from .env', async () => {
    const exampleTask = buildFile.getTask('example_with_dotenv')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg, [])
    expectLog(mock, '123456')
    expectLog(mock, 'echo 123456')
  })

  it('should use process env', async () => {
    const exampleTask = buildFile.getTask('example_with_shell_env')
    const [arg, mock] = getTestArg()
    arg.envs.processEnvs['VERSION'] = '1.0.0'
    await exampleTask.execute(arg, [])
    expectLog(mock, '1.0.0')
    expectLog(mock, 'echo 1.0.0')
  })

  it('should throw if process env is missing', async () => {
    const exampleTask = buildFile.getTask('example_with_shell_env')
    const [arg] = getTestArg()
    await expect(exampleTask.execute(arg, [])).rejects.toEqual(new Error('missing env $VERSION'))
  })
})
