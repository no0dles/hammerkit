import { join } from 'path'
import { getTestArg } from './run-arg'
import { parseBuildFile } from '../src/parse'

describe('local', () => {
  const fileName = join(__dirname, '../examples/local/build.yaml')
  const buildFile = parseBuildFile(fileName, null)

  it('should run local task', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg, mock] = getTestArg()
    await exampleTask.execute(arg)
  })
})
