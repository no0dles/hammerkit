import { join } from 'path'
import { getTestSuite } from '../get-test-suite'

describe('cancellation', () => {
  const suite = getTestSuite('cancellation', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  async function testAbort(taskName: string, expectedState: string) {
    const { cli, environment } = await suite.setup({ taskName })
    const exec = await cli.exec({ logMode: 'live' })
    const abortNode = Object.values(exec.state.current.node).find((n) => n.node.name.startsWith('long_'))
    exec.processManager.on((evt) => {
      if (evt.type === 'started' && evt.context.id === abortNode?.node.id) {
        environment.abortCtrl.abort()
      }
    })
    const result = await exec.start()
    expect(result.success).toBeFalsy()
    if (abortNode) {
      expect(result.state.node[abortNode.node.id].type).toEqual(expectedState)
    } else {
      expect(abortNode).toBeDefined()
    }
    expect(await environment.file.exists(join(suite.path, 'test'))).toBeFalsy()
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
