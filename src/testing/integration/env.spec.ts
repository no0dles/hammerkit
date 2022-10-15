import { expectLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'

describe('env', () => {
  const suite = getTestSuite('env', ['build.yaml', '.env'])

  afterAll(() => suite.close())

  it('should use env from build file', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
    await expectLog(result, environment, `example`, '16.6.0')
  })

  it('should pass env to docker', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example_docker' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
    await expectLog(result, environment, `example_docker`, '16.6.0')
  })

  it('should use env from task', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example_override' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
    await expectLog(result, environment, `example_override`, '15.0.0')
  })

  it('should use env from .env', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example_with_dotenv' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
    await expectLog(result, environment, `example_with_dotenv`, '123456')
  })

  it('should use process env', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example_with_shell_env' })
    environment.processEnvs['VERSION'] = '1.0.0'
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
    await expectLog(result, environment, `example_with_shell_env`, '1.0.0')
  })

  it('should throw if process env is missing', async () => {
    const { cli } = await suite.setup({ taskName: 'example_with_shell_env' })
    const result = await cli.exec()
    expect(result.success).toBeFalsy()
  })
})
