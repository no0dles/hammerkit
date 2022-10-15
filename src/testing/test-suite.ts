import { Cli } from './cli'
import { Environment } from '../executer/environment'
import { WorkScope } from '../executer/work-scope'

export interface TestSuite {
  path: string

  setup(scope: WorkScope): Promise<TestSuiteSetup>

  close(): Promise<void>
}

export interface TestSuiteSetup {
  cli: Cli
  environment: Environment
}
