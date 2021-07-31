import { BuildFile } from '../parser/build-file'
import { TestContext } from './test-context'
import { ExecutionContext } from '../executer/execution-context'
import { TestSuiteOptions } from './test-suite-options'

export interface TestSuite {
  setup(
    executionOptions?: TestSuiteOptions
  ): Promise<{ context: TestContext; executionContext: ExecutionContext; buildFile: BuildFile }>

  close(): Promise<void>
}
