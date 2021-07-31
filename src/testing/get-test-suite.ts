import { join } from 'path'
import { BuildFile } from '../parser/build-file'
import { getBuildFile } from '../parser/get-build-file'
import { ExecutionContext } from '../executer/execution-context'
import { TestSuite } from './test-suite'
import { TestContext } from './test-context'
import { TestSuiteOptions } from './test-suite-options'
import { getDockerExecutor } from '../executer/get-docker-executor'
import { getConsoleContextMock } from '../console/get-console-context-mock'
import { getFileContext } from '../file/get-file-context'
import { emitter } from '../utils/emitter'
import { Defer } from '../utils/defer'

interface Test {
  cwd: string
}

export function getTestSuite(exampleName: string, files: string[]): TestSuite {
  const exampleDirectory = join(__dirname, '../examples/', exampleName)
  const testDirectory = join(process.cwd(), 'temp', exampleName)
  const file = getFileContext()
  const tests: Test[] = []

  return {
    async close(): Promise<void> {
      for (const test of tests) {
        await file.remove(test.cwd)
      }
    },
    async setup(
      executionOptions?: TestSuiteOptions
    ): Promise<{ context: TestContext; executionContext: ExecutionContext; buildFile: BuildFile }> {
      const context: TestContext = {
        processEnvs: { ...process.env },
        cancelDefer: new Defer<void>(),
        cwd: testDirectory,
        file,
        console: getConsoleContextMock(),
      }

      await file.remove(testDirectory)
      await file.createDirectory(testDirectory)

      for (const file of files) {
        await context.file.copy(join(exampleDirectory, file), join(testDirectory, file))
      }

      const fileName = join(testDirectory, 'build.yaml')
      const buildFile = await getBuildFile(fileName, context)

      const executionContext: ExecutionContext = {
        environment: context,
        watch: executionOptions?.watch ?? false,
        cacheMethod: executionOptions?.cacheMethod ?? 'checksum',
        workers: executionOptions?.workers ?? 0,
        events: emitter(),
        executor: getDockerExecutor(),
        runningNodes: {},
      }

      tests.push({
        cwd: testDirectory,
      })

      return { buildFile, context, executionContext }
    },
  }
}
