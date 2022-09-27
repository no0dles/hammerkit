import { MockedTestCase, TestCase, TestSuite, TestSuiteSetupOptions } from './test-suite'
import { FileContext } from '../file/file-context'
import { join } from 'path'
import { getFileContext } from '../file/get-file-context'
import { TestEnvironment } from './test-environment'
import { getConsoleContextMock } from '../console/get-console-context-mock'
import { getBuildFile } from '../parser/get-build-file'
import { getTestCase } from './get-test-case'

interface Test {
  cwd: string
}

export class ExampleTestSuite implements TestSuite {
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
