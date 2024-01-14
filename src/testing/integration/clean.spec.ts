import { join } from 'path'
import { existsSync } from 'fs'
import { expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { existsVolume } from '../../executer/get-docker-executor'
import { getVolumeName } from '../../planner/utils/plan-work-volume'
import { getContainerCli } from '../../executer/execute-docker'
import { requiresLinuxContainers } from '../requires-linux-containers'

describe('clean', () => {
  const suite = getTestSuite('clean', ['.hammerkit.yaml', 'package.json'])

  afterAll(() => suite.close())

  it('should clean generated outputs locally', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example' })
    const result = await cli.runExec({ cacheDefault: 'none' })
    await expectSuccessfulResult(result, environment)

    const outputPath = join(suite.path, 'node_modules')

    expect(existsSync(outputPath)).toBeTruthy()
    await cli.clean()
    expect(existsSync(outputPath)).toBeFalsy()
  })

  it('should clean generated outputs in containers',  requiresLinuxContainers (async () => {
    const { cli, environment } = await suite.setup({ taskName: 'docker:example' })
    const result = await cli.runExec({ cacheDefault: 'none' })
    await expectSuccessfulResult(result, environment)

    const docker = getContainerCli({ type: 'docker' })
    const outputPath = join(suite.path, 'node_modules')
    const volumeName = getVolumeName(outputPath)
    expect(await existsVolume(docker, volumeName)).toBeTruthy()

    await cli.clean()
    expect(await existsVolume(docker, volumeName)).toBeFalsy()
  }))

  it('should clean and restore created data in volumes',  requiresLinuxContainers (async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example:service' })

    const result = await cli.runExec()
    await expectSuccessfulResult(result, environment)

    await cli.clean()
    const resultAfterClean = await cli.runExec()
    await expectSuccessfulResult(resultAfterClean, environment)
  }))
})
