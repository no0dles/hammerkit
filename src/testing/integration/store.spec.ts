import { join } from 'path'
import { expectSuccessfulResult } from '../expect'
import { restore } from '../../executer/restore'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { store } from '../../executer/store'
import { clean } from '../../executer/clean'
import { planWorkNodes } from '../../planner/utils/plan-work-nodes'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'
import { existsSync } from 'fs'

describe('store/restore', () => {
  const suite = getTestSuite('store-restore', ['build.yaml'])

  afterAll(() => suite.close())

  it('should clean created outputs', async () => {
    const { buildFile, context, executionContext } = await suite.setup()

    const outputPath = join(buildFile.path, 'test-output')
    const generatedPath = join(buildFile.path, 'node_modules')

    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)

    expect(existsSync(generatedPath)).toBeTruthy()
    expect(existsSync(outputPath)).toBeFalsy()

    await store(workTree.nodes, outputPath, context)
    await clean(workTree.nodes, context)

    expect(existsSync(outputPath)).toBeTruthy()
    expect(existsSync(generatedPath)).toBeFalsy()

    await restore(workTree.nodes, outputPath, context)
    expect(existsSync(outputPath)).toBeTruthy()
    expect(existsSync(generatedPath)).toBeTruthy()
  })

  it('should not store anything if nothing got generated', async () => {
    const { buildFile, context } = await suite.setup()
    const workNodes = planWorkNodes(buildFile)
    const outputPath = join(buildFile.path, 'test-output')
    const generatedPath = join(buildFile.path, 'node_modules')

    expect(existsSync(generatedPath)).toBeFalsy()
    expect(existsSync(outputPath)).toBeFalsy()

    await store(workNodes, outputPath, context)
    await restore(workNodes, outputPath, context)

    expect(existsSync(generatedPath)).toBeFalsy()
    expect(existsSync(outputPath)).toBeFalsy()
  })
})
