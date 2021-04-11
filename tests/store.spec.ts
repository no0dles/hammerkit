import { join, dirname } from 'path'
import { getTestArg, loadExampleBuildFile } from './run-arg'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { remove } from '../src/file/remove'

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

    const [storeArg] = getTestArg()
    await buildFile.store(storeArg, dirname(buildFile.fileName), storePath)

    const [cleanArg] = getTestArg()
    await buildFile.clean(cleanArg)
    expect(existsSync(outputPath)).toBeFalsy()

    const [restoreArg] = getTestArg()
    await buildFile.restore(restoreArg, dirname(buildFile.fileName), storePath)
    expect(existsSync(outputPath)).toBeTruthy()
  })

  it('should not store anything if nothing got generated', async () => {

    expect(existsSync(outputPath)).toBeFalsy()
    expect(existsSync(storePath)).toBeFalsy()
    const [storeArg] = getTestArg()
    await buildFile.store(storeArg, dirname(buildFile.fileName), storePath)
    const [restoreArg] = getTestArg()
    await buildFile.restore(restoreArg, dirname(buildFile.fileName), storePath)
    expect(existsSync(outputPath)).toBeFalsy()
    expect(existsSync(storePath)).toBeFalsy()
  })
})
