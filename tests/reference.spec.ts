import {expectLog, getTestArg, loadExampleBuildFile} from './run-arg';

describe('reference', () => {
  const buildFile = loadExampleBuildFile('reference')

  it('should run included task', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expectLog(mock, 'foobar')
    expectLog(mock, 'cat foobar.txt')
    expectLog(mock, 'hammertime')
    expectLog(mock, 'echo hammertime')
  })

  it('should list task with references tasks nested', async () => {
    const tasks = Array.from(buildFile.getTasks())
    expect(tasks.map((t) => t.getAbsoluteName())).toEqual(['example', 'foo:bar', 'foo:sub:sub'])
  })
})
