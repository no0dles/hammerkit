import { join } from 'path'
import { getTestArg, loadExampleBuildFile } from './run-arg'
import { existsSync } from 'fs'
import { remove } from '../src/file/remove'
import { execute } from '../src/executer/execute'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { clean } from '../src/executer/clean'

describe('clean', () => {
  it('should clean generated outputs', async () => {
    const buildFile = loadExampleBuildFile('clean')
    const outputPath = join(buildFile.path, 'node_modules')
    await remove(outputPath)

    const [arg] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
    expect(existsSync(outputPath)).toBeTruthy()

    await clean(buildFile)
    expect(existsSync(outputPath)).toBeFalsy()
  })
})
