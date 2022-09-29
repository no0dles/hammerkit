import { expectLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'

describe('env', () => {
  const suite = getTestSuite('env', ['build.yaml', '.env'])

  afterAll(() => suite.close())

  it('should use env from build file', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'example' })
    await expectSuccessfulResult(result)
    await expectLog(result, `example`, '16.6.0')
  })

  it('should pass env to docker', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'example_docker' })
    await expectSuccessfulResult(result)
    await expectLog(result, `example_docker`, '16.6.0')
  })

  it('should use env from task', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'example_override' })
    await expectSuccessfulResult(result)
    await expectLog(result, `example_override`, '15.0.0')
  })

  it('should use env from .env', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'example_with_dotenv' })
    await expectSuccessfulResult(result)
    await expectLog(result, `example_with_dotenv`, '123456')
  })

  it('should use process env', async () => {
    const testCase = await suite.setup()
    testCase.environment.processEnvs['VERSION'] = '1.0.0'
    const result = await testCase.exec({ taskName: 'example_with_shell_env' })
    await expectSuccessfulResult(result)
    await expectLog(result, `example_with_shell_env`, '1.0.0')
  })

  it('should throw if process env is missing', async () => {
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'example_with_shell_env' })
    expect(result.success).toBeFalsy()
    //expect(result.nodes[`${buildFile.path}:example_with_shell_env`].type).toEqual('failed')
  })
})
