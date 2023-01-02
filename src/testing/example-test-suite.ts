import { TestSuite, TestSuiteOptions } from './test-suite'
import { FileContext } from '../file/file-context'
import { join } from 'path'
import { getFileContext } from '../file/get-file-context'
import { statusConsole } from '../planner/work-node-status'
import { Environment } from '../executer/environment'
import { createCli } from '../program'
import { TestSuiteSetup } from './test-suite-setup'
import { getContainerCli } from '../executer/execute-docker'
import { createWriteStream } from 'fs'
import { consoleContext } from '../log'

interface Test {
  cwd: string
}

export class ExampleTestSuite implements TestSuite {
  private readonly file: FileContext
  private readonly tests: Test[] = []
  private readonly exampleDirectory: string

  readonly path: string

  constructor(private exampleName: string, private files: string[]) {
    this.exampleDirectory = join(__dirname, '../../examples/', exampleName)
    this.path = join(process.cwd(), 'temp', exampleName)
    this.file = getFileContext(this.path)
  }

  async close(): Promise<void> {
    for (const test of this.tests) {
      await this.file.remove(test.cwd)
    }
  }

  async setup(scope: TestSuiteOptions): Promise<TestSuiteSetup> {
    await this.file.remove(this.path)
    await this.file.createDirectory(this.path)

    const logPath = join(process.cwd(), 'logs')
    const stdoutFile = join(logPath, this.exampleName + '-stout.log')
    const statusFile = join(logPath, this.exampleName + '-status.log')
    const consoleFile = join(logPath, this.exampleName + '-console.log')

    await this.file.createDirectory(logPath)
    await this.file.remove(stdoutFile)
    await this.file.remove(statusFile)
    await this.file.remove(consoleFile)

    const environment: Environment = {
      processEnvs: { ...process.env, ...(scope.envs ?? {}) },
      abortCtrl: new AbortController(),
      cwd: this.path,
      file: this.file,
      console: consoleContext(createWriteStream(consoleFile)),
      status: statusConsole(createWriteStream(statusFile)),
      docker: getContainerCli(),
      stdout: createWriteStream(stdoutFile),
      stdoutColumns: 80,
    }

    for (const file of this.files) {
      await this.file.copy(join(this.exampleDirectory, file), join(this.path, file))
    }

    const fileName = join(this.path, '.hammerkit.yaml')

    this.tests.push({
      cwd: this.path,
    })

    const cli = await createCli(fileName, environment, scope)
    await cli.clean({ service: true })

    // reset cli clean stats
    environment.status = statusConsole(createWriteStream(statusFile, { flags: 'a' }))

    return {
      cli,
      environment,
    }
  }
}
