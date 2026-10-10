import { TestSuite, TestSuiteOptions } from './test-suite'
import { FileContext } from '../file/file-context'
import { join } from 'path'
import { getFileContext } from '../file/get-file-context'
import { statusConsole } from '../planner/work-item-status'
import { createSecretRegistry } from '../utils/redact'
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

  constructor(
    exampleName: string,
    private files: string[]
  ) {
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
    // Empty the directory instead of removing and recreating it: Docker
    // Desktop's file sharing keeps a stale view of a directory that is deleted
    // and recreated between tests, so bind mounts from it then fail with
    // "error while creating mount source path … no such file or directory".
    await this.file.createDirectory(this.path)
    for (const entry of await this.file.listFiles(this.path)) {
      await this.file.remove(join(this.path, entry))
    }

    const statusStream = memoryStream()
    const secrets = createSecretRegistry()
    const environment: Environment = {
      processEnvs: { ...process.env, ...(scope.envs ?? {}) },
      abortCtrl: new AbortController(),
      cwd: this.path,
      file: this.file,
      console: consoleContext(emptyStream()),
      status: statusConsole(statusStream.stream, secrets),
      secrets,
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
    // clear the backend cache too: the default `local` backend persists under
    // ~/.hammerkit/remote-cache outside the test's temp dir, so without this a
    // prior run's result would leak in and make cache assertions flaky.
    await cli.clean({ cache: true })

    // reset cli clean stats
    environment.status = statusConsole(statusStream.stream, secrets)

    return {
      cli,
      environment,
    }
  }
}
