import { loadExampleBuildFile } from './run-arg'
import { join } from 'path'
import { appendFileSync } from 'fs'
import { remove } from '../src/file/remove'
import { plan } from '../src/rewrite/1-plan'
import { restructure } from '../src/rewrite/2-restructure'
import { optimize, writeCache } from '../src/rewrite/3-optimize'

describe('glob', () => {
  const buildFile = loadExampleBuildFile('glob')
  const cachePath = join(buildFile.path, '.hammerkit')

  beforeEach(async () => {
    await remove(cachePath)
  })

  it('should remove task after written cache', async () => {
    const depTree = restructure(plan(buildFile, 'example'), true)
    expect(depTree).toContainKey(`${buildFile.path}:example`)

    await optimize(depTree)
    expect(depTree).toContainKey(`${buildFile.path}:example`)

    await writeCache(depTree[`${buildFile.path}:example`])

    const afterCacheDepTree = { ...depTree }
    await optimize(afterCacheDepTree)
    expect(afterCacheDepTree).not.toContainKey(`${buildFile.path}:example`)
  })

  it('should keep being cached after ignored file changed', async () => {
    const depTree = restructure(plan(buildFile, 'example'), true)
    expect(depTree).toContainKey(`${buildFile.path}:example`)

    await writeCache(depTree[`${buildFile.path}:example`])

    appendFileSync(join(buildFile.path, 'test.txt'), '\n')

    await optimize(depTree)
    expect(depTree).not.toContainKey(`${buildFile.path}:example`)
  })

  it('should invalid cache after file has changed', async () => {
    const depTree = restructure(plan(buildFile, 'example'), true)
    expect(depTree).toContainKey(`${buildFile.path}:example`)

    await writeCache(depTree[`${buildFile.path}:example`])

    appendFileSync(join(buildFile.path, 'test.md'), '\n')

    await optimize(depTree)
    expect(depTree).toContainKey(`${buildFile.path}:example`)
  })
})
