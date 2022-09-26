import { BuildFile } from '../parser/build-file'
import { HammerkitEvent } from '../executer/events'
import { CacheMethod } from '../optimizer/cache-method'
import { WorkNode } from '../planner/work-node'
import { Environment } from '../executer/environment'
import { LogMode } from '../logging/log-mode'
import { WorkNodeValidation } from '../planner/work-node-validation'
import { Process, UpdateBus } from '../executer/emitter'
import { SchedulerResult } from '../executer/scheduler/scheduler-result'

export interface ExecutionMock<T> {
  task(name: string): ExecutionMockNode
  getProcess(key: string): Process<T, T> | null
}

export interface ExecutionMockNode {
  set(options: { duration?: number; exitCode: number }): this
  executeCount: number
}

export interface MockedTestCase extends TestCase {
  executionMock: ExecutionMock<HammerkitEvent>
}

export interface ExecOptions {
  cacheMethod: CacheMethod
  workers: number
  watch: boolean
  noContainer: boolean
  logMode: LogMode
}

export interface UpOptions {
  watch: boolean
  logMode: LogMode
}

export interface TestCase {
  environment: Environment
  buildFile: BuildFile
  eventBus: UpdateBus<HammerkitEvent>

  exec(taskName: string, options?: Partial<ExecOptions>): Promise<SchedulerResult>

  store(path: string): Promise<void>
  restore(path: string): Promise<void>
  clean(): Promise<void>
  validate(): AsyncGenerator<WorkNodeValidation>

  getNode(name: string): WorkNode
  getNodes(): Generator<WorkNode>
  up(options?: Partial<UpOptions>): Promise<void>
}

export interface TestSuiteSetupOptions {
  mockExecution: true
}

export interface TestSuite {
  setup(): Promise<TestCase>
  setup(options: Partial<TestSuiteSetupOptions>): Promise<MockedTestCase>

  close(): Promise<void>
}
