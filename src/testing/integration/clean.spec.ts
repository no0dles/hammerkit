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
    const testCase = await suite.setup()
    const result = await testCase.exec({ taskName: 'example' }, { cacheDefault: 'none', noContainer: true })
    await expectSuccessfulResult(result)

    const outputPath = join(testCase.buildFile.path, 'node_modules')

    expect(existsSync(outputPath)).toBeTruthy()
    await testCase.clean()
    expect(existsSync(outputPath)).toBeFalsy()
  })

  it('should clean generated outputs in containers', async () => {
    const testCase = await suite.setup()
    const node = testCase.getNode('example')
    const result = await testCase.exec({ taskName: 'example' }, { cacheDefault: 'none' })
    await expectSuccessfulResult(result)

    const outputPath = join(testCase.buildFile.path, 'node_modules')
    const volumeName = getVolumeName(outputPath)
    const docker = await getDocker(node)
    expect(await existsVolume(docker, volumeName)).toBeTruthy()

    await testCase.clean()
    expect(await existsVolume(docker, volumeName)).toBeFalsy()
  })
})
