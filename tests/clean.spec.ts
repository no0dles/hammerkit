import { join, dirname } from 'path'
import { getTestArg, loadExampleBuildFile } from './run-arg'
import { existsSync } from 'fs'
import { remove } from '../src/remove'

describe('clean', () => {
  it('should clean created outputs', async () => {
    const buildFile = loadExampleBuildFile('clean')
    const outputPath = join(dirname(buildFile.fileName), 'node_modules')
    const [arg] = getTestArg()

    await remove(outputPath)

    await buildFile.getTask('example').execute(arg)
    expect(existsSync(outputPath)).toBeTruthy()
    await buildFile.clean()
    expect(existsSync(outputPath)).toBeFalsy()
  })
})
