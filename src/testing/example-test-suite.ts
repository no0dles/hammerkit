import { TestSuite, TestSuiteSetup } from './test-suite'
import { FileContext } from '../file/file-context'
import { join } from 'path'
import { getFileContext } from '../file/get-file-context'
import { consoleContextMock } from '../console/console-context-mock'
import { statusConsole } from '../planner/work-node-status'
import { Environment } from '../executer/environment'
import { WorkScope } from '../executer/work-scope'
import { createCli } from '../program'

interface Test {
  cwd: string
}

export class ExampleTestSuite implements TestSuite {
  private readonly file: FileContext
  private readonly tests: Test[] = []
  private readonly exampleDirectory: string

  readonly path: string

  constructor(exampleName: string, private files: string[]) {
    this.exampleDirectory = join(__dirname, '../../examples/', exampleName)
    this.path = join(process.cwd(), 'temp', exampleName)
    this.file = getFileContext(this.path)
  }

  async close(): Promise<void> {
    for (const test of this.tests) {
      await this.file.remove(test.cwd)
    }
  }

  async setup(scope: WorkScope): Promise<TestSuiteSetup> {
    await this.file.remove(this.path)
    await this.file.createDirectory(this.path)

    const environment: Environment = {
      processEnvs: { ...process.env },
      abortCtrl: new AbortController(),
      cwd: this.path,
      file: this.file,
      console: consoleContextMock(),
      status: statusConsole(),
    }

    for (const file of this.files) {
      await this.file.copy(join(this.exampleDirectory, file), join(this.path, file))
    }

    const fileName = join(this.path, 'build.yaml')

    this.tests.push({
      cwd: this.path,
    })

    const cli = await createCli(fileName, environment, scope)
    await cli.clean()

    return {
      cli,
      environment,
    }
  }
}
