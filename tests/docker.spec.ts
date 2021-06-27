import { expectLog, getTestArg, loadExampleBuildFile } from './run-arg'
import { execute } from '../src/executer/execute'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'

describe('docker', () => {
  const buildFile = loadExampleBuildFile('docker')

  it('should pull docker image', async () => {
    const [arg, mock] = getTestArg()
    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, arg)
    expect(result.success).toBeTruthy()
    expectLog(mock, '6.14.11')
    expectLog(mock, 'v14.16.0')
  })
})
