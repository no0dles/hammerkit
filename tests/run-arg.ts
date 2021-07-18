import { join } from 'path'
import { Defer } from '../src/defer'
import { BuildFile } from '../src/parser/build-file'
import { getBuildFile } from '../src/parser/parse-build-file'
import { ConsoleContext, ExecutionContext, fileContext, FileContext } from '../src/run-arg'
import { CacheMethod } from '../src/optimizer/cache-method'
import { ExecuteResult } from '../src/executer/execute-result'
import { emitter } from '../src/emit'
import { WorkNode } from '../src/planner/work-node'
import { WorkTree } from '../src/planner/work-tree'

export interface TestContext {
  processEnvs: { [key: string]: string | undefined }
  cancelDefer: Defer<void>
  cwd: string
  file: FileContext
  console: TestConsoleContext
}

export interface TestConsoleContext extends ConsoleContext {
  expectLog(message: string): { fulfilled: boolean }
}

function testConsoleContext(): TestConsoleContext {
  const expectedLogs: { [key: string]: { fulfilled: boolean } } = {}

  function complete(message: string) {
    const obj = expectedLogs[message]
    if (obj) {
      obj.fulfilled = true
      delete expectedLogs[message]
    }
  }

  return {
    warn(message: string) {
      complete(message)
    },
    info(message: string) {
      complete(message)
    },
    error(message: string) {
      complete(message)
    },
    debug(message: string) {
      complete(message)
    },
    expectLog(message: string): { fulfilled: boolean } {
      expectedLogs[message] = { fulfilled: false }
      return expectedLogs[message]
    },
  }
}

export interface TestSuite {
  setup(
    executionOptions?: TestSuiteOptions
  ): Promise<{ context: TestContext; executionContext: ExecutionContext; buildFile: BuildFile }>

  close(): Promise<void>
}

export interface TestSuiteOptions {
  workers?: number
  noContainer?: boolean
  cacheMethod?: CacheMethod
  watch?: boolean
}

export async function expectSuccessfulResult(result: ExecuteResult): Promise<void> {
  if (!result.success) {
    for (const nodeId of Object.keys(result.nodes)) {
      const node = result.nodes[nodeId]
      if (node.state.type === 'failed') {
        expect({
          nodeId,
          status: node.state.type,
          logs: await node.console.read(),
        }).toEqual({
          nodeId,
          status: 'completed',
        })
      }
    }
  }
}

export async function expectLog(result: ExecuteResult, nodeId: string, message: string): Promise<void> {
  const logs = await result.nodes[nodeId].console.read()
  expect(logs.map((l) => l.message)).toContain(message)
}
export async function expectContainsLog(result: ExecuteResult, nodeId: string, message: string): Promise<void> {
  const logs = await result.nodes[nodeId].console.read()
  expect(logs.some((l) => l.message.indexOf(message))).toBeTrue()
}

export function getTestContext(cwd: string): TestContext {
  const context: TestContext = {
    processEnvs: { ...process.env },
    cancelDefer: new Defer<void>(),
    cwd,
    file: fileContext(),
    console: testConsoleContext(),
  }
  return context
}

export function getNode(buildFile: BuildFile, workTree: WorkTree, taskName: string): WorkNode {
  return workTree.nodes[`${buildFile.path}:${taskName}`]
}

export function getTestSuite(exampleName: string, files: string[]): TestSuite {
  const exampleDirectory = join(__dirname, '../examples/', exampleName)
  const testDirectory = join(process.cwd(), 'disttmp', exampleName)
  const file = fileContext()
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
        console: testConsoleContext(),
      }

      await file.remove(testDirectory)
      await file.createDirectory(testDirectory)

      for (const file of files) {
        await context.file.copy(join(exampleDirectory, file), join(testDirectory, file))
      }

      const fileName = join(testDirectory, 'build.yaml')
      const buildFile = await getBuildFile(fileName, context)

      const executionContext: ExecutionContext = {
        context,
        watch: executionOptions?.watch ?? false,
        cacheMethod: executionOptions?.cacheMethod ?? 'checksum',
        workers: executionOptions?.workers ?? 0,
        noContainer: process.env.SKIP_DOCKER === 'true' ? true : executionOptions?.noContainer ?? false,
        events: emitter(),
        runningNodes: {},
      }

      tests.push({
        cwd: testDirectory,
      })

      return { buildFile, context, executionContext }
    },
  }
}

interface Test {
  cwd: string
}
