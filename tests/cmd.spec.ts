import { getTestArg, loadExampleBuildFile } from './run-arg'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'

describe('clean', () => {
  const buildFile = loadExampleBuildFile('cmd')

  it('should run with path arg', async () => {
    const [arg, mock] = getTestArg()

    const workTree = planWorkTree(buildFile, 'example')
    await execute(workTree, arg)
    expect(mock.mock.calls.some((c) => c[0].endsWith('cmd/sub'))).toBeTruthy()
  })
})
