import { join } from 'path'
import { existsSync } from 'fs'
import { expectSuccessfulResult } from '../expect'
import { getTestSuite } from '../get-test-suite'
import { getDocker, getVolumeName } from '../../executer/execute-docker'
import { existsVolume } from '../../executer/get-docker-executor'

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
    const node = cli.node('docker:example')
    const result = await cli.exec({ cacheDefault: 'none' })
    await expectSuccessfulResult(result, environment)

    const outputPath = join(suite.path, 'node_modules')
    const volumeName = getVolumeName(outputPath)
    const docker = await getDocker(environment.status.task(node))
    expect(await existsVolume(docker, volumeName)).toBeTruthy()

    await cli.clean()
    expect(await existsVolume(docker, volumeName)).toBeFalsy()
  })
})
