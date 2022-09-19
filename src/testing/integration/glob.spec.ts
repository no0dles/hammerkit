import { join } from 'path'
import { appendFileSync } from 'fs'
import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'
import { BuildFile } from '../../parser/build-file'
import { SchedulerTerminationEvent } from '../../executer/events'
import { NodeState } from '../../executer/scheduler/node-state'
import { MockedTestCase } from '../test-suite'

describe('glob', () => {
  const suite = getTestSuite('glob', ['build.yaml', 'test.md', 'test.txt'])

  afterAll(() => suite.close())

  async function getTestRun(testCase: MockedTestCase) {
    testCase.executionMock.clearNode('example')
    const taskMock = testCase.executionMock.getNode('example')
    taskMock.setDuration(100)
    return await testCase.exec('example')
  }

  async function getTestNode(testCase: MockedTestCase, state: SchedulerTerminationEvent): Promise<NodeState> {
    const node = testCase.getNode('example')
    return state.state.node[node.id]
  }

  async function testCache(expectInvalidate: boolean, action?: (buildFile: BuildFile) => Promise<void>) {
    const testCase = await suite.setup({ mockExecution: true })
    const result1 = await getTestRun(testCase)
    await expectSuccessfulResult(result1)

    const nodeState1 = await getTestNode(testCase, result1)

    expect(nodeState1.type).toEqual('completed')
    if (nodeState1.type === 'completed') {
      expect(nodeState1.duration).toBeGreaterThanOrEqual(100)
    }

    if (action) {
      await action(testCase.buildFile)
    }

    const result2 = await getTestRun(testCase)
    await expectSuccessfulResult(result2)

    const nodeState2 = await getTestNode(testCase, result2)

    expect(nodeState2.type).toEqual('completed')
    if (nodeState2.type === 'completed') {
      if (expectInvalidate) {
        expect(nodeState2.duration).toBeGreaterThanOrEqual(100)
      } else {
        expect(nodeState2.duration).toBe(0)
      }
    }
  }

  it('should remove task after written cache', async () => {
    await testCache(false)
  })

  it('should keep being cached after ignored file changed', async () => {
    await testCache(false, async (buildFile) => {
      appendFileSync(join(buildFile.path, 'test.txt'), '\n')
    })
  })

  it('should invalid cache after file has changed', async () => {
    await testCache(true, async (buildFile) => {
      appendFileSync(join(buildFile.path, 'test.md'), '\n')
    })
  })
})
