import { TestSuite, TestSuiteOptions } from './test-suite'
import { FileContext } from '../file/file-context'
import { join } from 'path'
import { getFileContext } from '../file/get-file-context'
import { statusConsole } from '../planner/work-item-status'
import { Environment } from '../executer/environment'
import { createCli } from '../program'
import { TestSuiteSetup } from './test-suite-setup'
import { consoleContext } from '../log'
import { emptyStream, memoryStream } from './test-streams'

interface Test {
  cwd: string
  close(): void
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
      test.close()
      await this.file.remove(test.cwd)
    }
  }

  async setup(scope: TestSuiteOptions): Promise<TestSuiteSetup> {
    await this.file.remove(this.path)
    await this.file.createDirectory(this.path)

    const statusStream= memoryStream()
    const environment: Environment = {
      processEnvs: { ...process.env, ...(scope.envs ?? {}) },
      abortCtrl: new AbortController(),
      cwd: this.path,
      file: this.file,
      console: consoleContext(emptyStream()),
      status: statusConsole(statusStream.stream),
      stdout: emptyStream(),
      stderr: emptyStream(),
      stdoutColumns: 80,
    }

    for (const file of this.files) {
      await this.file.copy(join(this.exampleDirectory, file), join(this.path, file))
    }

    const fileName = join(this.path, '.hammerkit.yaml')

    this.tests.push({
      cwd: this.path,
      close() {
        environment.abortCtrl.abort()
      },
    })

    const cli = await createCli(fileName, environment, scope)
    await cli.clean()

    // reset cli clean stats
    environment.status = statusConsole(statusStream.stream)

    return {
      cli,
      environment,
    }
  }
}
