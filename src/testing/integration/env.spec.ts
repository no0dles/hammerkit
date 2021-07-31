import { expectLog, expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'

describe('env', () => {
  const suite = getTestSuite('env', ['build.yaml', '.env'])

  afterAll(() => suite.close())

  it('should use env from build file', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:example`, '14.16.0')
  })

  it('should pass env to docker', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example_docker')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:example_docker`, '14.16.0')
  })

  it('should use env from task', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example_override')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:example_override`, '15.0.0')
  })

  it('should use env from .env', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example_with_dotenv')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:example_with_dotenv`, '123456')
  })

  it('should use process env', async () => {
    const { buildFile, executionContext } = await suite.setup()
    executionContext.environment.processEnvs['VERSION'] = '1.0.0'
    const workTree = planWorkTree(buildFile, 'example_with_shell_env')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    await expectLog(result, `${buildFile.path}:example_with_shell_env`, '1.0.0')
  })

  it('should throw if process env is missing', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example_with_shell_env')
    const result = await execute(workTree, executionContext)
    expect(result.success).toBeFalsy()
    //expect(result.nodes[`${buildFile.path}:example_with_shell_env`].type).toEqual('failed')
  })
})
