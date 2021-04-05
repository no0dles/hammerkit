import { join } from 'path'
import { getTestArg } from './run-arg'
import { parseBuildFile } from '../src/parse'

describe('reference', () => {
  const fileName = join(__dirname, '../examples/reference/build.yaml')
  const buildFile = parseBuildFile(fileName, null)

  it('should run included task', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expect(mock.mock.calls.length).toBe(4)
    expect(mock.mock.calls[0][0]).toEqual('foobar')
    expect(mock.mock.calls[1][0]).toEqual('cat foobar.txt')
    expect(mock.mock.calls[2][0]).toEqual('hammertime')
    expect(mock.mock.calls[3][0]).toEqual('echo hammertime')
  })

  it('should list task with references tasks nested', async () => {
    const tasks = Array.from(buildFile.getTasks())
    expect(tasks.map((t) => t.getAbsoluteName())).toEqual(['example', 'foo:bar', 'foo:sub:sub'])
  })
})
