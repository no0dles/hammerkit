import commaner, { Command } from 'commander'
import { existsSync, writeFileSync } from 'fs'
import { parseBuildFile } from './parse'
import consola, { LogLevel } from 'consola'
import { RunArg } from './run-arg'

export function getProgram(fileName: string): commaner.Command {
  const program = new Command()

  if (existsSync(fileName)) {
    const buildFile = parseBuildFile(fileName, null)
    const reservedCommands = ['clean', 'store', 'restore', 'validate']

    program
      .command('clean')
      .description('clear task cache')
      .action(async () => {
        try {
          await buildFile.clean()
        } catch (e) {
          consola.error(e)
          process.exit(1)
        }
      })

    program
      .command('store <path>')
      .description('save task outputs into <path>')
      .action(async (path) => {
        try {
          await buildFile.restore(path)
        } catch (e) {
          consola.error(e)
          process.exit(1)
        }
      })

    program
      .command('restore <path>')
      .description('restore task outputs from <path>')
      .action(async (path) => {
        try {
          await buildFile.restore(path)
        } catch (e) {
          consola.error(e)
          process.exit(1)
        }
      })

    program
      .command('validate')
      .description('validate build.yaml')
      .action(async () => {
        try {
          let count = 0
          const arg = new RunArg(false, 0)
          for (const validation of buildFile.validate(arg)) {
            let logger = consola.withTag(validation.buildFile.fileName)
            if (validation.task) {
              logger = logger.withTag(validation.task.getAbsoluteName())
            }
            if (validation.type === 'error') {
              logger.error(validation.message)
            } else {
              logger.warn(validation.message)
            }

            count++
          }

          if (count === 0) {
            consola.success(`${buildFile} is valid`)
          }
        } catch (e) {
          process.exit(1)
        }
      })

    for (const task of buildFile.getTasks()) {
      const name = task.getAbsoluteName()
      if (reservedCommands.indexOf(name) >= 0) {
        consola.warn(`${name} is reserved, please use another name`)
        continue
      }

      program
        .command(name)
        .description(task.getDescription())
        .option('-v, --verbose', 'log debugging information', false)
        .option('-w, --worker <number>', 'parallel worker count', parseInt, 4)
        .option('--no-cache', 'ignore task cache', false)
        .action(async (options) => {
          const runArg = new RunArg(!options.cache, options.workers)

          if (options.verbose) {
            runArg.logger.level = LogLevel.Debug
          }

          try {
            await task.execute(runArg)
          } catch (e) {
            runArg.logger.error(e)
            process.exit(1)
          }
        })
    }
  } else {
    program
      .command('init')
      .description('creates default build.yaml')
      .action(async () => {
        const content = `envs: {}

tasks:
  example:
    image: alpine
    cmds:
      echo "it's Hammer Time!"
      `
        writeFileSync(fileName, content)
        consola.success(`created ${fileName}`)
      })
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  program.version(require('../package.json').version)
  program.name('hammerkit')

  return program
}
