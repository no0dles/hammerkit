import { join } from 'path'
import { getTestSuite } from '../get-test-suite'
import { iterateWorkNodes } from '../../planner/utils/plan-work-nodes'

describe('cancellation', () => {
  const suite = getTestSuite('cancellation', ['build.yaml'])

  afterAll(() => suite.close())

  async function testAbort(taskName: string, expectedState: string) {
    const { cli, environment } = await suite.setup({ taskName })
    let nodeId: string = ''
    const exec = await cli.execWatch({ logMode: 'live' })
    exec.state.on((state) => {
      for (const node of iterateWorkNodes(state.node)) {
        if (node.node.name.startsWith('long_') && node.type === 'running') {
          nodeId = node.node.id
          environment.abortCtrl.abort()
        }
      }
    })
    const result = await exec.start()
    expect(result.success).toBeFalsy()
    expect(result.state.node[nodeId].type).toEqual(expectedState)
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
