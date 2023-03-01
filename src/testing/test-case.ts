import { TestSuiteOptions } from './test-suite'
import { join } from 'path'
import { getFileContext } from '../file/get-file-context'
import { Environment } from '../executer/environment'
import { consoleContext } from '../log'
import { createWriteStream } from 'fs'
import { statusConsole } from '../planner/work-item-status'
import { createCli } from '../program'
import { stringify as yamlSerialize } from 'yaml'
import { runProgram } from '../run-program'
import { Cli } from '../cli'

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

      const logPath = join(process.cwd(), 'logs')
      const stdoutFile = join(logPath, name + '-stout.log')
      const stderrFile = join(logPath, name + '-stderr.log')
      const statusFile = join(logPath, name + '-status.log')
      const consoleFile = join(logPath, name + '-console.log')

      await file.createDirectory(logPath)
      await file.remove(stdoutFile)
      await file.remove(statusFile)
      await file.remove(consoleFile)

      try {
        await file.remove(path)
        await file.createDirectory(path)

        const environment: Environment = {
          processEnvs: { ...process.env },
          abortCtrl: new AbortController(),
          cwd: path,
          file,
          console: consoleContext(createWriteStream(consoleFile)),
          status: statusConsole(createWriteStream(statusFile)),
          stdout: createWriteStream(stdoutFile),
          stderr: createWriteStream(stderrFile),
          stdoutColumns: 80,
        }

        for (const [fileName, fileContent] of Object.entries(files)) {
          await file.writeFile(
            join(path, fileName),
            typeof fileContent === 'string' ? fileContent : yamlSerialize(fileContent)
          )
        }

        await fn(path, environment)
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
