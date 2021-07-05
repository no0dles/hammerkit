import {getTestSuite} from './run-arg';

describe('multi-line', () => {
  const suite = getTestSuite('multi-line', ['build.yaml'])

  afterAll(() => suite.close())

  it('should get multi lines', async () => {
    const {buildFile} = await suite.setup()
    const task = buildFile.tasks['example']
    expect(task.cmds || []).toEqual([
      'some very long cmd continues on line 2',
      'some other very long cmd continues on line 2',
    ])
    expect(task.description).toEqual('Test multiline description')
  })
})
