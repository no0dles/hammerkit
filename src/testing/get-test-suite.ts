import { getBuildFile } from '../parser/get-build-file'
import { TestCase, TestSuite } from './test-suite'
import { Environment } from '../executer/environment'
import { getTestCase } from './get-test-case'
import { ExampleTestSuite } from './example-test-suite'

export function getTestSuite(exampleName: string, files: string[]): TestSuite {
  return new ExampleTestSuite(exampleName, files)
}

export async function getCli(fileName: string, environment: Environment): Promise<TestCase> {
  const buildFile = await getBuildFile(fileName, environment)
  return getTestCase(buildFile, environment)
}
