import { join } from 'path'
import { getTestArg } from './run-arg'
import { parseBuildFile } from '../src/parse'

describe('docker', () => {
  const fileName = join(__dirname, '../examples/docker/build.yaml')
  const buildFile = parseBuildFile(fileName, null)

  it('should pull docker image', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
    expect(mock.mock.calls.length).toBe(2)
    expect(mock.mock.calls[0][0]).toEqual('6.14.11')
    expect(mock.mock.calls[1][0]).toEqual('v14.16.0')
  })
})
