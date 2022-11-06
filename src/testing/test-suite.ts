import { WorkScope } from '../executer/work-scope'
import { TestSuiteSetup } from './test-suite-setup'

export type TestSuiteOptions = WorkScope & { envs?: { [key: string]: string } }

export interface TestSuite {
  path: string

  setup(scope: TestSuiteOptions): Promise<TestSuiteSetup>

  close(): Promise<void>
}
