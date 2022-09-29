import { getTestSuite } from '../get-test-suite'
import { NodeStartEvent } from '../../executer/events'

describe('watch', () => {
  const suite = getTestSuite('watch', ['build.yaml', 'src', 'package.json', 'package-lock.json', 'tsconfig.json'])

  afterAll(() => suite.close())

  it('should run watch task and cancel', async () => {
    const testCase = await suite.setup()
    const apiNode = testCase.getNode('api')
    testCase.eventBus.on<NodeStartEvent>('node-start', (evt) => {
      if (evt.node.id === apiNode.id) {
        testCase.environment.abortCtrl.abort()
      }
    })
    const result = await testCase.exec({ taskName: 'api' }, { watch: true })
    expect(result.success).toBeFalsy()
    expect(result.state.node[apiNode.id].type).toEqual('canceled')
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
