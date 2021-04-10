import { expectLog, getTestArg, loadExampleBuildFile } from './run-arg'
import { join } from 'path'

describe('include', () => {
  const buildFile = loadExampleBuildFile('include')

  it('should run included task', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expectLog(mock, 'foobar')
    expectLog(mock, 'cat foobar.txt')
  })

  it('should get name:example', () => {
    const includedTask = buildFile.getTask('name:example')
    expect(includedTask).not.toBeNull()
  })

  it('should get included task', async () => {
    const includedTask = buildFile.getTask('foo:bar')
    expect(includedTask).not.toBeNull()
    expect(includedTask.getAbsoluteName()).toEqual('foo:bar')
    expect(includedTask.getWorkingDirectory()).toEqual(join(__dirname, '../examples/include'))
  })
})
