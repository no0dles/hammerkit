import { join, dirname } from 'path'
import { getTestArg, loadExampleBuildFile } from './run-arg'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { remove } from '../src/remove'

describe('store/restore', () => {
  const buildFile = loadExampleBuildFile('store-restore')
  const outputPath = join(dirname(buildFile.fileName), 'node_modules')
  const storePath = join(tmpdir(), 'storetest')

  beforeEach(async () => {
    await remove(outputPath)
    await remove(storePath)
  })

  it('should clean created outputs', async () => {
    const [arg] = getTestArg()

    await buildFile.getTask('example').execute(arg)
    expect(existsSync(outputPath)).toBeTruthy()
    await buildFile.store(storePath)
    await buildFile.clean()
    expect(existsSync(outputPath)).toBeFalsy()
    await buildFile.restore(storePath)
    expect(existsSync(outputPath)).toBeTruthy()
  })

  it('should not store anything if nothing got generated', async () => {
    expect(existsSync(outputPath)).toBeFalsy()
    expect(existsSync(storePath)).toBeFalsy()
    await buildFile.store(storePath)
    await buildFile.restore(storePath)
    expect(existsSync(outputPath)).toBeFalsy()
    expect(existsSync(storePath)).toBeFalsy()
  })
})
