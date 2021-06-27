import { join } from 'path'
import { getTestArg, loadExampleBuildFile } from './run-arg'
import { existsSync } from 'fs'
import { tmpdir } from 'os'
import { remove } from '../src/file/remove'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { restore } from '../src/executer/restore'
import { store } from '../src/executer/store'
import { clean } from '../src/executer/clean'

describe('store/restore', () => {
  const buildFile = loadExampleBuildFile('store-restore')
  const outputPath = join(buildFile.path, 'node_modules')
  const cacheDir = join(buildFile.path, '.hammerkit')
  const storePath = join(tmpdir(), 'storetest')

  beforeEach(async () => {
    await remove(outputPath)
    await remove(storePath)
    await remove(cacheDir)
  })

  it('should clean created outputs', async () => {
    const [arg] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
    expect(existsSync(outputPath)).toBeTruthy()
    expect(existsSync(cacheDir)).toBeTruthy()

    await store(buildFile, storePath)

    await clean(buildFile)
    expect(existsSync(outputPath)).toBeFalsy()
    expect(existsSync(cacheDir)).toBeFalsy()

    await restore(buildFile, storePath)
    expect(existsSync(outputPath)).toBeTruthy()
    expect(existsSync(cacheDir)).toBeTruthy()
  })

  it('should not store anything if nothing got generated', async () => {
    expect(existsSync(outputPath)).toBeFalsy()
    expect(existsSync(storePath)).toBeFalsy()

    await store(buildFile, storePath)
    await restore(buildFile, storePath)

    expect(existsSync(outputPath)).toBeFalsy()
  })
})
