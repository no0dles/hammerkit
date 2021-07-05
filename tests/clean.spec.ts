import { join } from 'path'
import {expectSuccessfulResult, getTestSuite} from './run-arg';
import { existsSync } from 'fs'
import { execute } from '../src/executer/execute'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { clean } from '../src/executer/clean'

describe('clean', () => {
  const suite = getTestSuite('clean', ['build.yaml'])

  afterAll(() => suite.close())

  it('should clean generated outputs', async () => {
    const {buildFile, context, executionContext} = await suite.setup()
    const workTree = planWorkTree(buildFile, 'example')

    const result = await execute(workTree, executionContext)
    expectSuccessfulResult(result);

    const outputPath = join(buildFile.path, 'node_modules');

    expect(existsSync(outputPath)).toBeTruthy()
    await clean(workTree.nodes, context)
    expect(existsSync(outputPath)).toBeFalsy()
  })
})
