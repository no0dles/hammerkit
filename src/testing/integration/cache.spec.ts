import 'jest-extended'
import { expectLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { join } from 'path'
import { Environment } from '../../executer/environment'
import { checkCacheState } from '../../executer/scheduler/enqueue-next'
import { read, write } from '../../parser/read-build-file'
import { requiresLinuxContainers } from '../requires-linux-containers'

describe('cache', () => {
  const suite = getTestSuite('cache', ['.hammerkit.yaml', 'package.json', 'package-lock.json'])

  afterAll(() => suite.close())

  async function testCache(action: (environment: Environment) => Promise<void>, expectInvalidate: boolean) {
    const setupBefore = await suite.setup({ taskName: 'example' })

    const result = await setupBefore.cli.exec().start()
    await expectSuccessfulResult(result, setupBefore.environment)

    await action(setupBefore.environment)

    const setupAfter = await suite.setup({ taskName: 'example' })
    const task = setupAfter.cli.task('example')

    const checksumUpToDate = await checkCacheState(task, 'checksum', setupAfter.environment)
    const modifyDateUpToDate = await checkCacheState(task, 'modify-date', setupAfter.environment)

    if (expectInvalidate) {
      expect(checksumUpToDate.cached).toBeFalsy()
      expect(modifyDateUpToDate.cached).toBeFalsy()
    } else {
      expect(checksumUpToDate.cached).toBeTruthy()
      expect(modifyDateUpToDate.cached).toBeTruthy()
    }
  }

  it('should run invalid cache on src file change',  requiresLinuxContainers (async () => {
    await testCache(async (environment) => {
      await environment.file.appendFile(join(environment.cwd, 'package.json'), '\n')
    }, true)
  }))

  it('should mount generations of dependant tasks',  requiresLinuxContainers (async () => {
    const { cli, environment } = await suite.setup({ taskName: 'dependant' })
    const result = await cli.runExec()
    await expectSuccessfulResult(result, environment)
    await expectLog(result, environment, `dependant`, 'node_modules')
  }))

  it('should invalid cache on image change',  requiresLinuxContainers (async () => {
    await testCache(async (environment) => {
      const buildFile = await read('.hammerkit.yaml', environment)
      buildFile.tasks['example'].image = '15.0.0'
      await write('.hammerkit.yaml', buildFile, environment)
    }, true)
  }))
})
