import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'
import { Environment } from '../../executer/environment'

describe('glob', () => {
  const suite = getTestSuite('glob', ['.hammerkit.yaml', 'test.md', 'test.txt'])

  afterAll(() => suite.close())

  async function testCache(expectInvalidate: boolean, action?: (env: Environment) => Promise<void>) {
    const { cli, environment } = await suite.setup({ taskName: 'example' })

    const result1 = await cli.runExec()
    await expectSuccessfulResult(result1, environment)

    const taskState1 = result1.state.tasks['example']

    expect(taskState1.state.current.type).toEqual('completed')
    if (taskState1.state.current.type === 'completed') {
      expect(taskState1.state.current.duration).toBeGreaterThanOrEqual(100)
    }

    if (action) {
      await action(environment)
    }

    const result2 = await cli.runExec()
    await expectSuccessfulResult(result2, environment)

    const taskState2 = result2.state.tasks['example']

    expect(taskState2.state.current.type).toEqual('completed')
    if (taskState2.state.current.type === 'completed') {
      if (expectInvalidate) {
        expect(taskState2.state.current.cached).toBeFalsy()
      } else {
        expect(taskState2.state.current.cached).toBeTruthy()
      }
    }
  }

  it('should remove task after written cache', async () => {
    await testCache(false)
  })

  it('should keep being cached after ignored file changed', async () => {
    await testCache(false, async (env) => {
      await env.file.appendFile('test.txt', '\n')
    })
  })

  it('should invalid cache after file has changed', async () => {
    await testCache(true, async (env) => {
      await env.file.appendFile('test.md', '\n')
    })
  })
})
