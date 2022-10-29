import { Cli } from '../cli'
import { Environment } from '../executer/environment'

export interface TestSuiteSetup {
  cli: Cli
  environment: Environment
}
