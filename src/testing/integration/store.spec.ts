import { join } from 'path'
import { getTestSuite } from '../get-test-suite'
import { existsSync } from 'fs'
import { expectSuccessfulResult } from '../expect'

describe('store/restore', () => {
  const suite = getTestSuite('store-restore', ['.hammerkit.yaml', 'package.json'])

  afterAll(() => suite.close())

  it('should clean and restore created outputs locally', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example' })

    const generatedPath = join(environment.cwd, 'node_modules')
    const cacheStoragePath = join(environment.cwd, 'storage')

    expect(existsSync(generatedPath)).toBeFalsy()
    expect(existsSync(cacheStoragePath)).toBeFalsy()

    const result = await cli.runExec({})
    await expectSuccessfulResult(result, environment)

    expect(existsSync(generatedPath)).toBeTruthy()
    expect(existsSync(cacheStoragePath)).toBeFalsy()

    await cli.store(cacheStoragePath)
    expect(existsSync(cacheStoragePath)).toBeTruthy()

    await cli.clean()
    expect(existsSync(generatedPath)).toBeFalsy()

    await cli.restore(cacheStoragePath)
    expect(existsSync(generatedPath)).toBeTruthy()

    const execAfterRestore = await cli.runExec()
    await expectSuccessfulResult(execAfterRestore, environment)

    const taskState = execAfterRestore.state.tasks['example']
    expect(taskState.state.current.type).toBe('completed')
    if (taskState.state.current.type === 'completed') {
      expect(taskState.state.current.cached).toBeTruthy()
    }
  })

  it('should clean and restore created outputs in container', async () => {
    const { cli, environment } = await suite.setup({ taskName: 'example:docker' })

    const cacheStoragePath = join(environment.cwd, 'storage')

    const firstExecResult = await cli.runExec()
    await expectSuccessfulResult(firstExecResult, environment)

    // TODO test store if path does not exists

    await cli.store(cacheStoragePath)
    await cli.clean()
    await cli.restore(cacheStoragePath)

    const execAfterRestore = await cli.runExec()
    await expectSuccessfulResult(execAfterRestore, environment)

    const taskState = execAfterRestore.state.tasks['example:docker']
    expect(taskState.state.current.type).toBe('completed')
    if (taskState.state.current.type === 'completed') {
      expect(taskState.state.current.cached).toBeTruthy()
    }
  }, 90000)
})
