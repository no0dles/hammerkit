import { join } from 'path'
import { existsSync } from 'fs'
import { expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { existsVolume } from '../../executer/get-docker-executor'
import { getVolumeName } from '../../planner/utils/plan-work-volume'

describe('clean', () => {
  const suite = getTestSuite('clean', ['build.yaml', 'package.json'])

  afterAll(() => suite.close())

  it('should clean generated outputs locally', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example' })
    const result = await cli.exec({ cacheDefault: 'none' })
    await expectSuccessfulResult(result, environment)

    const outputPath = join(suite.path, 'node_modules')

    expect(existsSync(outputPath)).toBeTruthy()
    await cli.clean()
    expect(existsSync(outputPath)).toBeFalsy()
  })

  it('should clean generated outputs in containers', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'docker:example' })
    const result = await cli.exec({ cacheDefault: 'none' })
    await expectSuccessfulResult(result, environment)

    const outputPath = join(suite.path, 'node_modules')
    const volumeName = getVolumeName(outputPath)
    expect(await existsVolume(environment, volumeName)).toBeTruthy()

    await cli.clean()
    expect(await existsVolume(environment, volumeName)).toBeFalsy()
  })

  it('should clean and restore created data in volumes', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example:service' })

    const result = await cli.exec()
    await expectSuccessfulResult(result, environment)

    await cli.clean({ service: true })
    const resultAfterClean = await cli.exec()
    await expectSuccessfulResult(resultAfterClean, environment)
  })
})
