import { existsSync } from 'fs'
import { join } from 'path'
import { expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { clean } from '../../executer/clean'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'

describe('monorepo', () => {
  const suite = getTestSuite('monorepo', ['build.yaml', 'projects', 'build.npm.yaml', 'build.tsc.yaml'])

  afterAll(() => suite.close())

  it('should build monorepo', async () => {
    const { buildFile, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'build')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
  }, 120000)

  it('should clean monorepo', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    const files = [
      join(buildFile.path, 'projects/a/node_modules'),
      join(buildFile.path, 'projects/a/dist'),
      join(buildFile.path, 'projects/b/node_modules'),
      join(buildFile.path, 'projects/b/dist'),
    ]
    const workTree = planWorkTree(buildFile, 'build')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
    for (const file of files) {
      expect(existsSync(file)).toBeTruthy()
    }
    await clean(workTree.nodes, context)
    for (const file of files) {
      expect(existsSync(file)).toBeFalsy()
    }
  }, 120000)
})
