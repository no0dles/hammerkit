import { expectLog, getTestArg, loadExampleBuildFile } from './run-arg'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'

describe('env', () => {
  const buildFile = loadExampleBuildFile('env')

  it('should use env from build file', async () => {
    const [arg, mock] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, '14.16.0')
    expectLog(mock, 'echo 14.16.0')
  })

  it('should pass env to docker', async () => {
    const [arg, mock] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example_docker')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, '14.16.0')
  })

  it('should use env from task', async () => {
    const [arg, mock] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example_override')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, '15.0.0')
    expectLog(mock, 'echo 15.0.0')
  })

  it('should use env from .env', async () => {
    const [arg, mock] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example_with_dotenv')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, '123456')
    expectLog(mock, 'echo 123456')
  })

  it('should use process env', async () => {
    const [arg, mock] = getTestArg()
    arg.processEnvs['VERSION'] = '1.0.0'
    const workTree = planWorkTree(buildFile, 'example_with_shell_env')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, '1.0.0')
    expectLog(mock, 'echo $VERSION')
  })

  it('should throw if process env is missing', async () => {
    const [arg] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example_with_shell_env')
    const result = await execute(workTree, arg)
    expect(result.success).toBeFalsy()
    expect(result.nodes[`${buildFile.path}:example_with_shell_env`].type).toEqual('failed')
  })
})
