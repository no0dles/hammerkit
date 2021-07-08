import { expectSuccessfulResult, getTestSuite } from './run-arg'
import { existsSync } from 'fs'
import { join } from 'path'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { clean } from '../src/executer/clean'

describe('monorepo', () => {
  const suite = getTestSuite('monorepo', ['build.yaml', 'projects', 'build.npm.yaml', 'build.tsc.yaml'])

  afterAll(() => suite.close())

  it('should build monorepo', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'build')
    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result)
  })

  it('should clean monorepo', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    const files = [
      join(buildFile.path, '.hammerkit'),
      join(buildFile.path, 'projects/a/.hammerkit'),
      join(buildFile.path, 'projects/a/node_modules'),
      join(buildFile.path, 'projects/a/dist'),
      join(buildFile.path, 'projects/b/.hammerkit'),
      join(buildFile.path, 'projects/b/node_modules'),
      join(buildFile.path, 'projects/b/dist'),
    ]
    const workTree = planWorkTree(buildFile, 'build')
    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result)
    for (const file of files) {
      expect(existsSync(file)).toBeTruthy()
    }
    await clean(workTree.nodes, context)
    for (const file of files) {
      expect(existsSync(file)).toBeFalsy()
    }
  })
})
