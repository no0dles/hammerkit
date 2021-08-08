import { join } from 'path'
import { existsSync } from 'fs'
import { expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { clean } from '../../executer/clean'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'

describe('clean', () => {
  const suite = getTestSuite('clean', ['build.yaml'])

  afterAll(() => suite.close())

  it('should clean generated outputs', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')

    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)

    const outputPath = join(buildFile.path, 'node_modules')

    expect(existsSync(outputPath)).toBeTruthy()
    await clean(workTree.nodes, context, executionContext.executor)
    expect(existsSync(outputPath)).toBeFalsy()
  })
})
