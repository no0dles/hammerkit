import { expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'

describe('concurrency', () => {
  const suite = getTestSuite('concurrency', ['.hammerkit.yaml'])

  afterAll(() => suite.close())

  it('should run with concurrency lower than total tasks', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example' })

    const exec = await cli.exec({ workers: 1 })
    exec.state.on('check-status', (state) => {
      const runningNodes = Object.values(state.nodes).filter((n) => n.state.current.type === 'running')
      expect(runningNodes.length).toBeLessThanOrEqual(1)
    })

    const result = await exec.start()
    await expectSuccessfulResult(result, environment)
  })
})
