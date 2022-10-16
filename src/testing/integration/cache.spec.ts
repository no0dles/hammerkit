import 'jest-extended'
import { writeWorkNodeCache } from '../../optimizer/write-work-node-cache'
import { expectLog, expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { join } from 'path'
import { Environment } from '../../executer/environment'
import { checkCacheState } from '../../executer/scheduler/enqueue-next'
import { read, write } from '../../parser/read-build-file'

describe('cache', () => {
  const suite = getTestSuite('cache', ['build.yaml', 'package.json', 'package-lock.json'])

  afterAll(() => suite.close())

  async function testCache(action: (environment: Environment) => Promise<void>, expectInvalidate: boolean) {
    const setupBefore = await suite.setup({ taskName: 'example' })
    const nodeBefore = setupBefore.cli.node('example')

    await writeWorkNodeCache(nodeBefore, 'checksum', setupBefore.environment)
    await action(setupBefore.environment)

    const setupAfter = await suite.setup({ taskName: 'example' })
    const node = setupAfter.cli.node('example')

    const checksumUpToDate = await checkCacheState(node, 'checksum', setupAfter.environment)
    const modifyDateUpToDate = await checkCacheState(node, 'modify-date', setupAfter.environment)

    if (expectInvalidate) {
      expect(checksumUpToDate.changed).toBeTruthy()
      expect(modifyDateUpToDate.changed).toBeTruthy()
    } else {
      expect(checksumUpToDate.changed).toBeFalsy()
      expect(modifyDateUpToDate.changed).toBeFalsy()
    }
  }

  it('should run invalid cache on src file change', async () => {
    await testCache(async (environment) => {
      await environment.file.appendFile(join(environment.cwd, 'package.json'), '\n')
    }, true)
  })

  it('should mount generations of dependant tasks', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'dependant' })
    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)
    await expectLog(result, environment, `dependant`, 'node_modules')
  })

  it('should invalid cache on image change', async () => {
    await testCache(async (environment) => {
      const buildFile = await read('build.yaml', environment)
      buildFile.tasks['example'].image = '15.0.0'
      await write('build.yaml', buildFile, environment)
    }, true)
  })
})
