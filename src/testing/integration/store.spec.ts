import { join } from 'path'
import { getTestSuite } from '../get-test-suite'
import { existsSync } from 'fs'
import { expectSuccessfulResult } from '../expect'

describe('store/restore', () => {
  const suite = getTestSuite('store-restore', ['build.yaml', 'package.json'])

  afterAll(() => suite.close())

  it('should clean and restore created outputs locally', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example' })

    const generatedPath = join(environment.cwd, 'node_modules')
    const cacheStoragePath = join(environment.cwd, 'storage')

    expect(existsSync(generatedPath)).toBeFalsy()
    expect(existsSync(cacheStoragePath)).toBeFalsy()

    const result = await cli.exec({})
    await expectSuccessfulResult(result, environment)

    expect(existsSync(generatedPath)).toBeTruthy()
    expect(existsSync(cacheStoragePath)).toBeFalsy()

    await cli.store(cacheStoragePath)
    expect(existsSync(cacheStoragePath)).toBeTruthy()

    await cli.clean()
    expect(existsSync(generatedPath)).toBeFalsy()

    await cli.restore(cacheStoragePath)
    expect(existsSync(generatedPath)).toBeTruthy()

    const execAfterRestore = await cli.exec()
    await expectSuccessfulResult(execAfterRestore, environment)

    const node = cli.node('example')
    const nodeState = execAfterRestore.state.node[node.id]
    expect(nodeState.type).toBe('completed')
    if (nodeState.type === 'completed') {
      expect(nodeState.cached).toBeTruthy()
    }
  })

  it('should clean and restore created outputs in container', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example:docker' })

    const cacheStoragePath = join(environment.cwd, 'storage')

    const firstExecResult = await cli.exec()
    await expectSuccessfulResult(firstExecResult, environment)

    await cli.store(cacheStoragePath)
    await cli.clean()
    await cli.restore(cacheStoragePath)

    const execAfterRestore = await cli.exec()
    await expectSuccessfulResult(execAfterRestore, environment)

    const node = cli.node('example:docker')
    const nodeState = execAfterRestore.state.node[node.id]
    expect(nodeState.type).toBe('completed')
    if (nodeState.type === 'completed') {
      expect(nodeState.cached).toBeTruthy()
    }
  }, 90000)
})
