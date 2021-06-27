import { getTestArg, loadExampleBuildFile } from './run-arg'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'

describe('local', () => {
  const buildFile = loadExampleBuildFile('local')

  it('should run local task', async () => {
    const [arg] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example')
    await execute(workTree, arg)
  })
})
