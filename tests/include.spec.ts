import { getTestArg, loadExampleBuildFile } from './run-arg'
import { join } from 'path'

describe('include', () => {
  const buildFile = loadExampleBuildFile('include')

  it('should run included task', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expect(mock.mock.calls.length).toBe(2)
    expect(mock.mock.calls[0][0]).toEqual('foobar')
    expect(mock.mock.calls[1][0]).toEqual('cat foobar.txt')
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
