import { join } from 'path'
import { getTestSuite } from '../get-test-suite'
import { NodeStartEvent } from '../../executer/events'

describe('cancellation', () => {
  const suite = getTestSuite('cancellation', ['build.yaml'])

  afterAll(() => suite.close())

  async function testAbort(taskName: string, expectedState: string) {
    const testCase = await suite.setup()
    let nodeId: string
    testCase.eventBus.on<NodeStartEvent>('node-start', (evt) => {
      if (!testCase.environment.abortCtrl.signal.aborted && evt.node.name.startsWith('long_')) {
        nodeId = evt.node.id
        setTimeout(() => {
          testCase.environment.abortCtrl.abort()
        }, 2000)
      }
    })
    const result = await testCase.exec(taskName)
    expect(result.success).toBeFalsy()
    expect(result.state.node[nodeId!].type).toEqual(expectedState)
    expect(await testCase.environment.file.exists(join(testCase.buildFile.path, 'test'))).toBeFalsy()
  }

  it('should cancel local task with dependencies', async () => {
    await testAbort('local_cancel', 'canceled')
  })

  it('should cancel local task', async () => {
    await testAbort('long_running_local', 'canceled')
  })

  it('should cancel docker task', async () => {
    await testAbort('long_running_docker', 'canceled')
  })

  it('should cancel docker task with dependencies', async () => {
    await testAbort('docker_cancel', 'canceled')
  })
})
