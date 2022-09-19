import { expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { NodeCompletedEvent, NodeStartEvent } from '../../executer/events'

describe('concurrency', () => {
  const suite = getTestSuite('concurrency', ['build.yaml'])

  afterAll(() => suite.close())

  it('should run with concurrency lower than total tasks', async () => {
    const testCase = await suite.setup()

    let concurrentRunners = 0
    testCase.eventBus.on<NodeStartEvent>('node-start', (evt) => {
      concurrentRunners++
      expect(concurrentRunners).toBeLessThanOrEqual(1)
    })
    testCase.eventBus.on<NodeCompletedEvent>(
      'node-completed',
      (evt) => {
        concurrentRunners--
      },
      true
    )

    const result = await testCase.exec('example', {
      workers: 1,
    })
    await expectSuccessfulResult(result)
  })
})
