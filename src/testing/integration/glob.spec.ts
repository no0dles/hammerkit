import { join } from 'path'
import { appendFileSync } from 'fs'
import { getTestSuite } from '../get-test-suite'
import { expectSuccessfulResult } from '../expect'
import { BuildFile } from '../../parser/build-file'

describe('glob', () => {
  const suite = getTestSuite('glob', ['build.yaml', 'test.md', 'test.txt'])

  afterAll(() => suite.close())

  async function testCache(action: (buildFile: BuildFile) => Promise<void>, expectInvalidate: boolean) {
    const testCase = await suite.setup({ mockExecution: true })
    const node = testCase.getNode('example')
    const taskMock = testCase.executionMock.getNode('example')
    taskMock.setDuration(100)

    const result1 = await testCase.exec('example')
    await expectSuccessfulResult(result1)

    const nodeState1 = result1.state.node[node.id]

    expect(nodeState1.type).toEqual('completed')
    if (nodeState1.type === 'completed') {
      expect(nodeState1.duration).toBeGreaterThanOrEqual(100)
    }

    await action(testCase.buildFile)

    const result2 = await testCase.exec('example')
    await expectSuccessfulResult(result2)

    const nodeState2 = result1.state.node[node.id]

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
    await testCache(async () => {}, false)
  })

  it('should keep being cached after ignored file changed', async () => {
    await testCache(async (buildFile) => {
      appendFileSync(join(buildFile.path, 'test.txt'), '\n')
    }, false)
  })

  it('should invalid cache after file has changed', async () => {
    await testCache(async (buildFile) => {
      appendFileSync(join(buildFile.path, 'test.md'), '\n')
    }, true)
  })
})
