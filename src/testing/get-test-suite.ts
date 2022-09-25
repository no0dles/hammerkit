import { dirname, join } from 'path'
import { BuildFile } from '../parser/build-file'
import { getBuildFile } from '../parser/get-build-file'
import { ExecOptions, MockedTestCase, TestCase, TestSuite, TestSuiteSetupOptions, UpOptions } from './test-suite'
import { TestEnvironment } from './test-environment'
import { getConsoleContextMock } from '../console/get-console-context-mock'
import { getFileContext } from '../file/get-file-context'
import { iterateWorkNodes, planWorkNodes } from '../planner/utils/plan-work-nodes'
import { WorkNode } from '../planner/work-node'
import { HammerkitEvent, SchedulerTerminationEvent, SchedulerUpResultEvent } from '../executer/events'
import { getNode } from './get-node'
import { planWorkTree } from '../planner/utils/plan-work-tree'
import { getFileContextMock } from '../file/get-file-context-mock'
import { createBuildFile } from './create-build-file'
import { FileContext } from '../file/file-context'
import { Environment } from '../executer/environment'
import { WorkNodeValidation } from '../planner/work-node-validation'
import { validate } from '../planner/validate'
import { isCI } from '../utils/ci'
import { groupedLogger } from '../logging/grouped-logger'
import { liveLogger } from '../logging/live-logger'
import { interactiveLogger } from '../logging/interactive-logger'
import { getSchedulerState, schedule, watchNode } from '../executer/hierarchy-scheduler'
import { UpdateBus, UpdateEmitter } from '../executer/emitter'
import { Logger, LogMode } from '../logging/log-mode'
import { failNever } from '../utils/fail-never'
import { SchedulerState } from '../executer/scheduler/scheduler-state'
import { getExecutionMock } from '../executer/event-exec-mock'
import { cleanCache, restoreCache, storeCache } from '../executer/event-cache'

interface Test {
  cwd: string
}

function getLogger(mode: LogMode, state: SchedulerState, bus: UpdateBus<HammerkitEvent>): Logger {
  if (mode === 'grouped') {
    return groupedLogger(state, bus)
  } else if (mode === 'live') {
    return liveLogger(state, bus)
  } else if (mode === 'interactive') {
    return interactiveLogger(state, bus)
  } else {
    failNever(mode, 'unknown log mode')
  }
}

function getTestCase(
  buildFile: BuildFile,
  environment: Environment,
  options?: Partial<TestSuiteSetupOptions>
): MockedTestCase | TestCase {
  const [nodes, services] = planWorkNodes(buildFile)

  const executionMock = getExecutionMock(buildFile, nodes, services, environment)
  const emitter = new UpdateEmitter<HammerkitEvent>(environment.abortCtrl.signal, (key, process) => {
    if (options?.mockExecution) {
      const mockedProcess = executionMock.getProcess(key)
      if (mockedProcess) {
        return mockedProcess
      }
    }

    return process
  })

  return {
    buildFile,
    environment,
    eventBus: emitter,
    executionMock,
    async exec(taskName: string, options?: Partial<ExecOptions>): Promise<SchedulerTerminationEvent> {
      const workTree = planWorkTree(buildFile, taskName)

      const cacheMethod = options?.cacheMethod ?? 'checksum'
      const initialState = getSchedulerState({
        type: 'scheduler-initialize',
        services: workTree.services,
        nodes: workTree.nodes,
        watch: options?.watch ?? false,
        cacheMethod: options?.cacheMethod ?? 'checksum',
        noContainer: options?.noContainer ?? false,
        workers: options?.workers ?? 0,
        logMode: options?.logMode ?? isCI ? 'live' : 'interactive',
      })
      const logMode: LogMode = options?.logMode ?? (isCI ? 'live' : 'interactive')
      const logger = getLogger(logMode, initialState, emitter)

      if (options?.watch) {
        for (const node of iterateWorkNodes(workTree.nodes)) {
          if (node.src.length > 0) {
            emitter.task(`watch:${node.id}`, watchNode(node, environment, cacheMethod))
          }
        }
      }

      const result = await schedule(emitter, initialState, environment)

      await logger.complete(result)

      return result
    },
    async clean(): Promise<void> {
      await cleanCache(nodes, services, environment)
    },
    async restore(path: string): Promise<void> {
      await restoreCache(path, nodes, services, environment)
    },
    async store(path: string): Promise<void> {
      await storeCache(path, nodes, services, environment)
    },
    getNode(name: string): WorkNode {
      const workTree = planWorkTree(buildFile, name)
      return getNode(buildFile, workTree.nodes, name)
    },
    async up(options?: Partial<UpOptions>): Promise<void> {
      // await eventBus.run<SchedulerUpResultEvent>('scheduler-up-result', {
      //   type: 'scheduler-up',
      //   services,
      //   watch: options?.watch ?? false,
      // })
    },
    getNodes(): Generator<WorkNode> {
      return iterateWorkNodes(nodes)
    },
    validate(): AsyncGenerator<WorkNodeValidation> {
      return validate(buildFile, environment)
    },
  }
}

class VirtualTestSuite implements TestSuite {
  constructor(private options: VirtualTestSuiteOptions) {}

  async close(): Promise<void> {
    return Promise.resolve()
  }

  setup(): Promise<TestCase>
  setup(options: Partial<TestSuiteSetupOptions>): Promise<MockedTestCase>
  async setup(options?: Partial<TestSuiteSetupOptions>): Promise<MockedTestCase | TestCase> {
    const cwd = '/home/test'
    const file = getFileContextMock()
    const environment: TestEnvironment = {
      processEnvs: { ...process.env },
      abortCtrl: new AbortController(),
      cwd,
      file,
      console: getConsoleContextMock(),
    }
    await file.createDirectory(cwd)
    for (const filePath in this.options.files) {
      await file.createDirectory(dirname(join(cwd, filePath)))
      await file.writeFile(join(cwd, filePath), this.options.files[filePath])
    }
    const buildFile = await createBuildFile(environment, this.options.buildFile)
    return getTestCase(buildFile, environment, options)
  }
}

export interface VirtualTestSuiteOptions {
  files: { [key: string]: string }
  buildFile: unknown
}

export function getVirtualTestSuite(virtualEnv: VirtualTestSuiteOptions): TestSuite {
  return new VirtualTestSuite(virtualEnv)
}

class ExampleTestSuite implements TestSuite {
  private readonly file: FileContext
  private readonly tests: Test[] = []
  private readonly exampleDirectory: string
  private readonly testDirectory: string

  constructor(exampleName: string, private files: string[]) {
    this.exampleDirectory = join(__dirname, '../../examples/', exampleName)
    this.testDirectory = join(process.cwd(), 'temp', exampleName)
    this.file = getFileContext()
  }

  async close(): Promise<void> {
    for (const test of this.tests) {
      await this.file.remove(test.cwd)
    }
  }

  setup(): Promise<TestCase>
  setup(options: Partial<TestSuiteSetupOptions>): Promise<MockedTestCase>
  async setup(options?: Partial<TestSuiteSetupOptions>): Promise<MockedTestCase | TestCase> {
    const environment: TestEnvironment = {
      processEnvs: { ...process.env },
      abortCtrl: new AbortController(),
      cwd: this.testDirectory,
      file: this.file,
      console: getConsoleContextMock(),
    }

    await this.file.remove(this.testDirectory)
    await this.file.createDirectory(this.testDirectory)

    for (const file of this.files) {
      await environment.file.copy(join(this.exampleDirectory, file), join(this.testDirectory, file))
    }

    const fileName = join(this.testDirectory, 'build.yaml')
    const buildFile = await getBuildFile(fileName, environment)

    this.tests.push({
      cwd: this.testDirectory,
    })

    const cli = getTestCase(buildFile, environment, options)
    await cli.clean()

    return cli
  }
}

export function getTestSuite(exampleName: string, files: string[]): TestSuite {
  return new ExampleTestSuite(exampleName, files)
}

export async function getCli(fileName: string, environment: Environment): Promise<TestCase> {
  const buildFile = await getBuildFile(fileName, environment)
  return getTestCase(buildFile, environment)
}
