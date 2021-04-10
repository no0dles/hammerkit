import { getTestArg, loadExampleBuildFile } from './run-arg'
import { dirname, join } from 'path'
import { appendFileSync } from 'fs'
import { remove } from '../src/file/remove'

describe('glob', () => {
  const buildFile = loadExampleBuildFile('glob')
  const cachePath = join(dirname(buildFile.fileName), '.hammerkit')

  beforeEach(async () => {
    await remove(cachePath)
  })

  it('should cache should only validate src glob files', async () => {
    const exampleTask = buildFile.getTask('example')
    const [arg] = getTestArg()
    expect(await exampleTask.isCached(arg)).toBeFalsy()
    await exampleTask.execute(arg)
    expect(await exampleTask.isCached(arg)).toBeTruthy()
    appendFileSync(join(dirname(buildFile.fileName), 'test.txt'), '\n')
    expect(await exampleTask.isCached(arg)).toBeTruthy()
  })
})
