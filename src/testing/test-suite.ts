import { BuildFile } from '../parser/build-file'
import { EventBus } from '../executer/event-bus'
import { SchedulerTerminationEvent } from '../executer/events'
import { CacheMethod } from '../optimizer/cache-method'
import { WorkNode } from '../planner/work-node'
import { Environment } from '../executer/environment'
import { LogMode } from '../logging/log-mode'
import { WorkNodeValidation } from '../planner/work-node-validation'

export interface ExecutionMock {
  getNode(name: string): ExecutionMockNode
}

export type MockNodeState = 'running' | 'pending' | 'ended'

export interface ExecutionMockNode {
  getState(): MockNodeState
  waitFor(state: MockNodeState): Promise<void>
  end(exitCode: number): void
  setDuration(durationInMs: number): void
}

export interface MockedTestCase extends TestCase {
  executionMock: ExecutionMock
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
  eventBus: EventBus

  exec(taskName: string, options?: Partial<ExecOptions>): Promise<SchedulerTerminationEvent>

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
