import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'
import { join } from 'path'

describe('watch', () => {
  const suite = getTestSuite('watch', ['build.yaml', 'src', 'package.json', 'package-lock.json', 'tsconfig.json'])

  afterAll(() => suite.close())

  it('should run watch task and cancel', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, 'api')

    executionContext.watch = true
    executionContext.events.on(({ workTree, nodeId, newState }) => {
      if (nodeId === workTree.rootNode.id && newState.type === 'running') {
        context.cancelDefer.resolve()
      }
    })
    const result = await execute(workTree, executionContext)

    expect(result.success).toBeFalsy()
    expect(result.nodes[workTree.rootNode.id].state.type).toEqual('aborted')
  })

  // it('should restart task if dependency updates', async () => {
  //   const { buildFile, context, executionContext } = await suite.setup()
  //   const workTree = planWorkTree(buildFile, 'api')
  //
  //   let restarted = false
  //
  //   executionContext.watch = true
  //   executionContext.events.on(({ nodeId, newState }) => {
  //     if (nodeId === workTree.rootNode.id && newState.type === 'running') {
  //       if (restarted) {
  //         context.cancelDefer.resolve()
  //       } else {
  //         context.file.appendFile(join(buildFile.path, 'package.json'), '\n')
  //         restarted = true
  //       }
  //     }
  //   })
  //   const result = await execute(workTree, executionContext)
  //
  //   expect(result.success).toBeFalsy()
  //   expect(result.nodes[workTree.rootNode.id].state.type).toEqual('aborted')
  // }, 120000)
})
