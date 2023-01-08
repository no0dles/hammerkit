import { expectLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { emptyWorkLabelScope } from '../../executer/work-scope'

describe('reference', () => {
  const suite = getTestSuite('reference', ['.hammerkit.yaml', 'foo'])

  afterAll(() => suite.close())

  it('should run included task', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example' })
    const result = await cli.runExec()
    await expectSuccessfulResult(result, environment)
    await expectLog(result, environment, `foo:bar`, 'foobar')
    await expectLog(result, environment, `example`, 'hammertime')
  })

  it('should list task with references tasks nested', async () => {
    const { cli } = await suite.setup(emptyWorkLabelScope('all'))
    const workNodes = cli.ls()
    expect(workNodes.map((t) => t.item.name)).toEqual(['foo:bardb', 'example', 'foo:bar', 'foo:sub:sub'])
  })
})
