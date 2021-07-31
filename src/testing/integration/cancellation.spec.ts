import { join } from 'path'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'

describe('cancellation', () => {
  const suite = getTestSuite('cancellation', ['build.yaml'])

  afterAll(() => suite.close())

  async function testAbort(taskName: string, expectedState: string) {
    const { buildFile, context, executionContext } = await suite.setup()
    const workTree = planWorkTree(buildFile, taskName)
    executionContext.events.on((evt) => {
      if (evt.newState.type === 'running' && !executionContext.environment.cancelDefer.isResolved) {
        evt.workTree.nodes[evt.nodeId].status.console.on((log) => {
          if (log.message.startsWith('execute cmd ')) {
            setTimeout(() => {
              executionContext.environment.cancelDefer.resolve()
            }, 2000)
          }
        })
      }
    })
    const result = await execute(workTree, executionContext)
    expect(result.success).toBeFalsy()
    expect(result.nodes[workTree.rootNode.id].state.type).toEqual(expectedState)
    expect(await context.file.exists(join(buildFile.path, 'test'))).toBeFalsy()
  }

  it('should cancel local task with dependencies', async () => {
    await testAbort('local_cancel', 'aborted')
  })

  it('should cancel local task', async () => {
    await testAbort('long_running_local', 'aborted')
  })

  it('should cancel docker task', async () => {
    await testAbort('long_running_docker', 'aborted')
  })

  it('should cancel docker task with dependencies', async () => {
    await testAbort('local_cancel', 'aborted')
  })
})
