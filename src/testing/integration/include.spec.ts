import { expectLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'

describe('include', () => {
  const suite = getTestSuite('include', ['build.yaml', 'foo', 'foobar.txt'])

  afterAll(() => suite.close())

  it('should run included task', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
    await expectLog(result, environment, `foo:bar`, 'foobar')
  })

  it('should get name:example', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'name:example' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
  })

  it('should get included task', async () => {
    const { cli } = await suite.setup({ taskName: 'foo:bar' })
    expect(cli.ls().map((n) => n.item.name)).toEqual(['foo:bar'])

    const item = cli.ls()[0]
    if (item.type === 'task') {
      expect(item.item.cwd).toBe(suite.path)
    } else {
      expect(item.type).toBe('task')
    }
  })
})
