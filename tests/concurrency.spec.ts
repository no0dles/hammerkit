import { expectSuccessfulResult, getTestSuite } from './run-arg'
import { planWorkTree } from '../src/planner/utils/plan-work-tree'
import { execute } from '../src/executer/execute'

describe('concurrency', () => {
  const suite = getTestSuite('concurrency', ['build.yaml'])

  afterAll(() => suite.close())

  it('should run with concurrency lower than total tasks', async () => {
    const { buildFile, executionContext } = await suite.setup()
    executionContext.workers = 1

    let concurrentRunners = 0
    executionContext.events.on((evt) => {
      if (evt.newState.type === 'running') {
        concurrentRunners++
      } else if (evt.newState.type === 'failed' || evt.newState.type === 'completed') {
        concurrentRunners--
      }

      expect(concurrentRunners).toBeLessThanOrEqual(1)
    })

    const workTree = planWorkTree(buildFile, 'example')
    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)
  })
})
