import { join } from 'path'
import { existsSync } from 'fs'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { restore } from '../src/executer/restore'
import { store } from '../src/executer/store'
import { clean } from '../src/executer/clean'
import { expectSuccessfulResult, getTestSuite } from './run-arg'
import { planWorkNodes } from '../src/planner/utils/plan-work-nodes'

describe('store/restore', () => {
  const suite = getTestSuite('store-restore', ['build.yaml'])

  afterAll(() => suite.close())

  it('should clean created outputs', async () => {
    const { buildFile, context, executionContext } = await suite.setup()

    const outputPath = join(buildFile.path, 'test-output')
    const generatedPath = join(buildFile.path, 'node_modules')

    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result)

    expect(existsSync(outputPath)).toBeTruthy()
    expect(existsSync(generatedPath)).toBeTruthy()

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
