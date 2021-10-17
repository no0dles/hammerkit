import { join } from 'path'
import { existsSync } from 'fs'
import { expectSuccessfulResult } from '../expect'
import { planWorkTree } from '../../planner/utils/plan-work-tree'
import { clean } from '../../executer/clean'
import { getTestSuite } from '../get-test-suite'
import { execute } from '../../executer/execute'
import { getLocalExecutor } from '../../executer/get-local-executor'
import { getDocker, getVolumeName } from '../../executer/execute-docker'
import { existsVolume, getDockerExecutor } from '../../executer/get-docker-executor'

describe('clean', () => {
  const suite = getTestSuite('clean', ['build.yaml', 'package.json'])

  afterAll(() => suite.close())

  it('should clean generated outputs locally', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    executionContext.executor = getLocalExecutor()
    executionContext.cacheMethod = 'none'

    const workTree = planWorkTree(buildFile, 'example')

    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)

    const outputPath = join(buildFile.path, 'node_modules')

    expect(existsSync(outputPath)).toBeTruthy()
    await clean(workTree.nodes, workTree.services, context, executionContext.executor)
    expect(existsSync(outputPath)).toBeFalsy()
  })

  it('should clean generated outputs in containers', async () => {
    const { buildFile, context, executionContext } = await suite.setup()
    executionContext.executor = await getDockerExecutor()
    executionContext.cacheMethod = 'none'

    const workTree = planWorkTree(buildFile, 'example')

    const result = await execute(workTree, executionContext)
    await expectSuccessfulResult(result)

    const outputPath = join(buildFile.path, 'node_modules')
    const volumeName = getVolumeName(outputPath)
    const docker = getDocker()
    expect(await existsVolume(docker, volumeName)).toBeTruthy()

    await clean(workTree.nodes, workTree.services, context, executionContext.executor)
    expect(await existsVolume(docker, volumeName)).toBeFalsy()
  })
})
