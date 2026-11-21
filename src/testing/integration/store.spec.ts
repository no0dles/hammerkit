import { dirname, join, relative } from 'path'
import { getTestSuite } from '../get-test-suite'
import { existsSync, mkdirSync } from 'fs'
import { expectSuccessfulResult } from '../expect'
import { listVolume } from '../read-volume'
import { requiresLinuxContainers } from '../requires-linux-containers'
import { extractOutput } from '../../utils/tar'

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

  it(
    'should clean and restore created outputs in container',
    requiresLinuxContainers(async () => {
      const { cli, environment } = await suite.setup({ taskName: 'example:docker' })

      const cacheStoragePath = join(environment.cwd, 'storage')

      const firstExecResult = await cli.runExec()
      await expectSuccessfulResult(firstExecResult, environment)

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
      // the restored outputs must actually be back in the task's volume
      expect(await listVolume(taskState.data.generates[0].volumeName)).toContain('.package-lock.json')
    }),
    900000
  )

  it(
    'archives an output of a container task with the folder of its path as the root of the entries',
    requiresLinuxContainers(async () => {
      const { cli, environment } = await suite.setup({ taskName: 'example:docker' })

      const result = await cli.runExec()
      await expectSuccessfulResult(result, environment)

      const task = result.state.tasks['example:docker']
      const [generate] = task.data.generates
      const archived = join(environment.cwd, 'archived')
      mkdirSync(archived)
      const [written] = await task.runtime.archive(environment, archived, { only: [generate.path] })

      // the container archives the output by its name, so its entries are relative to the folder of it
      expect(written.root).toBe(dirname(generate.path))
      expect(written.filename.startsWith(archived)).toBe(true)

      const extracted = join(environment.cwd, 'extracted')
      mkdirSync(extracted)
      const output = relative(written.root, generate.path)
      await extractOutput(written.filename, extracted, output, false)
      expect(existsSync(join(extracted, output, '.package-lock.json'))).toBeTruthy()
    }),
    900000
  )
})
