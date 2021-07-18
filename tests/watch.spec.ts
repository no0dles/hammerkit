import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'
import { join } from 'path'
import { getTestSuite } from './run-arg'

describe('watch', () => {
  const suite = getTestSuite('watch', ['build.yaml', 'src', 'package.json', 'package-lock.json', 'tsconfig.json'])

  afterAll(() => suite.close())

  it('should run watch task and cancel', async () => {
    const { buildFile, context, executionContext } = await suite.setup()

    const apiNodeId = `${buildFile.path}:api`

    executionContext.watch = true
    executionContext.events.on(({ workTree, nodeId, oldState, newState }) => {
      if (nodeId === apiNodeId && newState.type === 'running') {
        context.cancelDefer.resolve()
      }
    })
    const workTree = planWorkTree(buildFile, 'api')
    const result = await execute(workTree, executionContext)

    expect(result.success).toBeFalsy()
    expect(result.nodes[apiNodeId].state.type).toEqual('aborted')
  })

  it('should restart task if dependency updates', async () => {
    const { buildFile, context, executionContext } = await suite.setup()

    const apiNodeId = `${buildFile.path}:api`
    let restarted = false

    executionContext.watch = true
    executionContext.events.on(({ nodeId, newState }) => {
      if (nodeId === apiNodeId && newState.type === 'running') {
        if (restarted) {
          context.cancelDefer.resolve()
        } else {
          context.file.appendFile(join(buildFile.path, 'package.json'), '\n')
          restarted = true
        }
      }
    })
    const workTree = planWorkTree(buildFile, 'api')
    const result = await execute(workTree, executionContext)

    expect(result.success).toBeFalsy()
    expect(result.nodes[apiNodeId].state.type).toEqual('aborted')
  })
})
