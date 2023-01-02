import { TestSuite } from './test-suite'
import { ExampleTestSuite } from './example-test-suite'

export function getTestSuite(exampleName: string, files: string[]): TestSuite {
  return new ExampleTestSuite(exampleName, files)
}
