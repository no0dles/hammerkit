import { getTestSuite } from '../get-test-suite'

describe('multi-line', () => {
  const suite = getTestSuite('multi-line', ['build.yaml'])

  afterAll(() => suite.close())

  it('should get multi lines', async () => {
    const { cli } = await suite.setup({ taskName: 'example' })
    const task = cli.node('example')
    expect((task.cmds || []).map((c) => c.cmd)).toEqual([
      'some very long cmd continues on line 2',
      'some other very long cmd continues on line 2',
    ])
    expect(task.description).toEqual('Test multiline description')
  })
})
