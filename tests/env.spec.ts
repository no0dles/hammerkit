import { expectLog, getTestArg, loadExampleBuildFile } from './run-arg'
import { executeTask } from '../src/rewrite/4-execute'

describe('env', () => {
  const buildFile = loadExampleBuildFile('env')

  it('should use env from build file', async () => {
    const [arg, mock] = getTestArg()
    const result = await executeTask(buildFile, 'example', false, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, '14.16.0')
    expectLog(mock, 'echo 14.16.0')
  })

  it('should pass env to docker', async () => {
    const [arg, mock] = getTestArg()
    const result = await executeTask(buildFile, 'example_docker', false, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, '14.16.0')
  })

  it('should use env from task', async () => {
    const [arg, mock] = getTestArg()
    const result = await executeTask(buildFile, 'example_override', false, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, '15.0.0')
    expectLog(mock, 'echo 15.0.0')
  })

  it('should use env from .env', async () => {
    const [arg, mock] = getTestArg()
    const result = await executeTask(buildFile, 'example_with_dotenv', false, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, '123456')
    expectLog(mock, 'echo 123456')
  })

  it('should use process env', async () => {
    const [arg, mock] = getTestArg()
    arg.processEnvs['VERSION'] = '1.0.0'
    const result = await executeTask(buildFile, 'example_with_shell_env', false, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, '1.0.0')
    expectLog(mock, 'echo 1.0.0')
  })

  it('should throw if process env is missing', async () => {
    const [arg] = getTestArg()
    const result = await executeTask(buildFile, 'example_with_shell_env', false, arg)
    expect(result.success).toBeFalsy()
    expect(result.tasks[`${buildFile.path}:example_with_shell_env`].errorMessage).toEqual('missing env $VERSION')
  })
})
