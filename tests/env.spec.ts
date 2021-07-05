import {expectLog, expectSuccessfulResult, getTestSuite} from './run-arg';
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'

describe('env', () => {
  const suite = getTestSuite('env', ['build.yaml', '.env'])

  afterAll(() => suite.close())

  it('should use env from build file', async () => {
    const {buildFile, executionContext} = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:example`,'info: 14.16.0')
  })

  it('should pass env to docker', async () => {
    const {buildFile, executionContext} = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example_docker')
    const result = await execute(workTree, executionContext)
    expect(result.success).toBeTruthy()
    await expectLog(result, `${buildFile.path}:example_docker`, 'info: 14.16.0')
  })

  it('should use env from task', async () => {
    const {buildFile, executionContext} = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example_override')
    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:example_override`,'info: 15.0.0')
  })

  it('should use env from .env', async () => {
    const {buildFile, executionContext} = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example_with_dotenv')
    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:example_with_dotenv`, 'info: 123456')
  })

  it('should use process env', async () => {
    const {buildFile, executionContext} = await suite.setup()
    executionContext.context.processEnvs['VERSION'] = '1.0.0'
    const workTree = planWorkTree(buildFile, 'example_with_shell_env')
    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:example_with_shell_env`,'info: 1.0.0')
  })

  it('should throw if process env is missing', async () => {
    const {buildFile, executionContext} = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example_with_shell_env')
    const result = await execute(workTree, executionContext)
    expect(result.success).toBeFalsy()
    //expect(result.nodes[`${buildFile.path}:example_with_shell_env`].type).toEqual('failed')
  })
})
