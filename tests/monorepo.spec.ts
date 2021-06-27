import { getTestArg, loadExampleBuildFile } from './run-arg'
import { existsSync } from 'fs'
import { join } from 'path'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { clean } from '../src/executer/clean'

describe('monorepo', () => {
  const buildFile = loadExampleBuildFile('monorepo')

  it('should build monorepo', async () => {
    const [arg] = getTestArg()
    const workTree = planWorkTree(buildFile, 'build')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
  })

  it('should clean monorepo', async () => {
    const files = [
      join(buildFile.path, '.hammerkit'),
      join(buildFile.path, 'projects/a/.hammerkit'),
      join(buildFile.path, 'projects/a/node_modules'),
      join(buildFile.path, 'projects/a/dist'),
      join(buildFile.path, 'projects/b/.hammerkit'),
      join(buildFile.path, 'projects/b/node_modules'),
      join(buildFile.path, 'projects/b/dist'),
    ]
    const [arg] = getTestArg()
    const workTree = planWorkTree(buildFile, 'build')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
    for (const file of files) {
      expect(existsSync(file)).toBeTruthy()
    }
    await clean(buildFile)
    for (const file of files) {
      expect(existsSync(file)).toBeFalsy()
    }
  })
})
