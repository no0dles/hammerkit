import { join } from 'path'
import { expectLog, getBuildFilePath, getTestArg, loadExampleBuildFile } from './run-arg'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs'
import { remove } from '../src/file/remove'
import { executeTask } from '../src/rewrite/4-execute'
import { restructure, TreeDependencies } from '../src/rewrite/2-restructure'
import { plan } from '../src/rewrite/1-plan'
import { optimize, writeCache } from '../src/rewrite/3-optimize'

describe('cache', () => {
  const buildFile = loadExampleBuildFile('cache')
  const cachePath = join(buildFile.path, '.hammerkit')
  const sourceFile = join(buildFile.path, 'package.json')
  const buildFilePath = getBuildFilePath('cache')
  const sourceFileContent = readFileSync(sourceFile)
  const buildFileContent = readFileSync(buildFilePath)

  beforeEach(async () => {
    if (existsSync(cachePath)) {
      await remove(cachePath)
    }
  })

  afterEach(() => {
    writeFileSync(buildFilePath, buildFileContent)
    writeFileSync(sourceFile, sourceFileContent)
  })

  async function testCache(action: (depTree: TreeDependencies) => Promise<void>, expectInvalidate: boolean) {
    const depTree = restructure(plan(buildFile, 'example'), true)
    expect(depTree).toContainKey(`${buildFile.path}:example`)

    await optimize(depTree, 'checksum')
    expect(depTree).toContainKey(`${buildFile.path}:example`)

    await writeCache(depTree[`${buildFile.path}:example`])
    await action(depTree)

    const afterCacheDepTree = { ...depTree }
    await optimize(afterCacheDepTree, 'checksum')

    if (expectInvalidate) {
      expect(afterCacheDepTree).toContainKey(`${buildFile.path}:example`)
    } else {
      expect(afterCacheDepTree).not.toContainKey(`${buildFile.path}:example`)
    }
  }

  it('should run invalid cache on src file change', async () => {
    await testCache(async () => {
      appendFileSync(sourceFile, '\n')
    }, true)
  })

  it('should mount generations of dependant tasks', async () => {
    const [arg, mock] = getTestArg()
    const result = await executeTask(buildFile, 'dependant', false, 'checksum', arg)
    expect(result.success).toBeTruthy()

    expectLog(mock, 'node_modules')
    expectLog(mock, 'package-lock.json')
    expectLog(mock, 'package.json')
  })

  it('should invalid cache on image change', async () => {
    await testCache(async (depTree) => {
      depTree[`${buildFile.path}:example`].task.image = '15.0.0'
    }, true)
  })
})
