import { WorkScope } from '../executer/work-scope'
import { TestSuiteSetup } from './test-suite-setup'

export interface TestSuite {
  path: string

  setup(scope: WorkScope): Promise<TestSuiteSetup>

  close(): Promise<void>
}
