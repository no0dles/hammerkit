import { join, dirname } from 'path'
import { getTestArg, loadExampleBuildFile } from './run-arg'
import { existsSync } from 'fs'
import { remove } from '../src/file/remove'

describe('clean', () => {
  it('should clean created outputs', async () => {
    const buildFile = loadExampleBuildFile('clean')
    const outputPath = join(dirname(buildFile.fileName), 'node_modules')
    const [arg] = getTestArg()

    await remove(outputPath)

    await buildFile.getTask('example').execute(arg)
    expect(existsSync(outputPath)).toBeTruthy()

    const [cleanArg] = getTestArg()
    await buildFile.clean(cleanArg)
    expect(existsSync(outputPath)).toBeFalsy()
  })
})
