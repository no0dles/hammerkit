import { TestSuiteOptions } from './test-suite'
import { join } from 'path'
import { getFileContext } from '../file/get-file-context'
import { Environment } from '../executer/environment'
import { consoleContext } from '../log'
import { statusConsole } from '../planner/work-item-status'
import { createCli } from '../program'
import { stringify as yamlSerialize } from 'yaml'
import { runProgram } from '../run-program'
import { Cli } from '../cli'
import { emptyStream, memoryStream } from './test-streams'

export function createTestCase(name: string, files: { [key: string]: any }) {
  return {
    async shell(args: string[]): Promise<void> {
      await this.setup(async (cwd, env) => {
        await runProgram(env, args, true)
      })
    },
    async setup(fn: (cwd: string, environment: Environment) => Promise<void> | void): Promise<void> {
      const path = join(process.cwd(), 'temp', name)
      const file = getFileContext(path)

      const statusStream= memoryStream()
      try {
        await file.remove(path)
        await file.createDirectory(path)

        const environment: Environment = {
          processEnvs: { ...process.env },
          abortCtrl: new AbortController(),
          cwd: path,
          file,
          console: consoleContext(emptyStream()),
          status: statusConsole(statusStream.stream),
          stdout: emptyStream(),
          stderr: emptyStream(),
          stdoutColumns: 80,
        }

        for (const [fileName, fileContent] of Object.entries(files)) {
          await file.writeFile(
            join(path, fileName),
            typeof fileContent === 'string' ? fileContent : yamlSerialize(fileContent)
          )
        }

        await fn(path, environment)
      } catch (e) {
        process.stdout.write(statusStream.read())
        throw e
      } finally {
        await file.remove(path)
      }
    },
    async cli(
      scope: TestSuiteOptions,
      fn?: (cli: Cli, environment: Environment) => Promise<void> | void
    ): Promise<void> {
      return this.setup(async (cwd, environment) => {
        const fileName = join(cwd, '.hammerkit.yaml')

        environment.processEnvs = { ...environment.processEnvs, ...(scope.envs ?? {}) }

        const cli = await createCli(fileName, environment, scope)
        await cli.clean()

        if (fn) {
          await fn(cli, environment)
        }
      })
    },
  }
}

export type TestCase = ReturnType<typeof createTestCase>
