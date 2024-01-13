import { getTestSuite } from '../get-test-suite'
import { Environment } from '../../executer/environment'
import { checkCacheState } from '../../executer/scheduler/enqueue-next'

describe('glob', () => {
  const suite = getTestSuite('glob', ['.hammerkit.yaml', 'test.md', 'test.txt'])

  afterAll(() => suite.close())

  async function testCache(expectInvalidate: boolean, action?: (env: Environment) => Promise<void>) {
    const { cli, environment } = await suite.setup({ taskName: 'example' })

    const task = cli.task('example')
    const cacheBefore = await checkCacheState(task, task.data.caching ?? 'checksum', environment)
    expect(cacheBefore.stateKey).not.toBeNull()

    if (action) {
      await action(environment)
    }

    const exampleAfter = cli.task('example')
    const cacheAfter = await checkCacheState(exampleAfter, task.data.caching ?? 'checksum', environment)
    expect(cacheAfter.stateKey).not.toBeNull()

    if(expectInvalidate) {
      expect(cacheAfter.stateKey).not.toEqual(cacheBefore.stateKey)
    } else {
      expect(cacheAfter.stateKey).toEqual(cacheBefore.stateKey)
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
