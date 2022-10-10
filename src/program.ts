import commaner, { Command, Option } from 'commander'
import { join, resolve } from 'path'
import { Environment } from './executer/environment'
import { isCI } from './utils/ci'
import { getCli } from './testing/get-test-suite'
import { parseLabelArguments } from './parser/parse-label-arguments'

export async function getProgram(
  environment: Environment,
  argv: string[]
): Promise<{ program: commaner.Command; args: string[] }> {
  const program = new Command()

  const args = [...argv]
  const fileIndex = args.indexOf('--file')
  const fileName = join(environment.cwd, fileIndex >= 0 ? args[fileIndex + 1] : 'build.yaml')
  if (fileIndex >= 0) {
    args.splice(fileIndex, 2)
  }

  if (await environment.file.exists(fileName)) {
    const cli = await getCli(fileName, environment)
    const reservedCommands = ['clean', 'store', 'restore', 'validate', 'up']

    program
      .command('clean')
      .description('clear task cache')
      .action(async () => {
        try {
          await cli.clean()
        } catch (e) {
          environment.console.error(e)
          process.exit(1)
        }
      })

    program
      .command('store <path>')
      .description('save task outputs into <path>')
      .action(async (path) => {
        try {
          await cli.store(resolve(path))
        } catch (e) {
          environment.console.error(e)
          process.exit(1)
        }
      })

    program
      .command('restore <path>')
      .description('restore task outputs from <path>')
      .action(async (path) => {
        try {
          await cli.restore(resolve(path))
        } catch (e) {
          environment.console.error(e)
          process.exit(1)
        }
      })

    program
      .command('validate')
      .description('validate build.yaml')
      .action(async () => {
        let errors = 0

        for await (const validation of cli.validate()) {
          if (validation.type === 'error') {
            errors++
            environment.console.error(validation.message)
          } else {
            environment.console.warn(validation.message)
          }
        }
        if (errors === 0) {
          process.exit(0)
        } else {
          process.exit(1)
        }
      })

    program
      .command('task', { isDefault: true })
      .arguments('[task]')
      .addOption(new Option('-c, --concurrency <number>', 'parallel worker count').argParser(parseInt).default(4))
      .addOption(new Option('-w, --watch', 'watch tasks').default(false))
      .addOption(
        new Option('-l, --log <mode>', 'log mode')
          .default(isCI ? 'live' : 'interactive')
          .choices(['interactive', 'live', 'grouped'])
      )
      .addOption(
        new Option('--cache <method>', 'caching method to compare')
          .default(isCI ? 'checksum' : 'modify-date')
          .choices(['checksum', 'modify-date', 'none'])
      )
      .addOption(new Option('--no-container', 'run every task locally without containers').default(false))
      .action(async (task, options) => {
        try {
          const result = await cli.exec(
            task
              ? { taskName: task }
              : {
                  excludeLabels: parseLabelArguments(options.exclude),
                  filterLabels: parseLabelArguments(options.filter),
                },
            {
              cacheDefault: options.cache,
              watch: options.watch,
              workers: options.concurrency,
              logMode: options.log,
              noContainer: !options.container,
            }
          )

          if (!result.success) {
            process.exit(1)
          }
        } catch (e) {
          process.exit(1)
        }
      })

    // program
    //   .command('up', { isDefault: true })
    //   .description('run all tasks / services')
    //   .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
    //   .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
    //   .option('-c, --concurrency <number>', 'parallel worker count', parseInt, 4)
    //   .addOption(new Option('-w, --watch', 'watch tasks').default(false))
    //   .addOption(
    //     new Option('-l, --log <mode>', 'log mode')
    //       .default(isCI ? 'live' : 'interactive')
    //       .choices(['interactive', 'live', 'grouped'])
    //   )
    //   .addOption(
    //     new Option('--cache <method>', 'caching method to compare')
    //       .default(isCI ? 'checksum' : 'modify-date')
    //       .choices(['checksum', 'modify-date', 'none'])
    //   )
    //   .addOption(new Option('--no-container', 'run every task locally without containers'))
    //   .action(async (options) => {
    //     console.log(options)
    //     const result = await cli.exec(
    //       {
    //         excludeLabels: parseLabelArguments(options.exclude),
    //         filterLabels: parseLabelArguments(options.filter),
    //       },
    //       {
    //         cacheDefault: options.cache,
    //         watch: options.watch,
    //         workers: options.concurrency,
    //         logMode: options.log,
    //         noContainer: options.container,
    //       }
    //     )
    //
    //     if (!result.success) {
    //       process.exit(1)
    //     }
    //   })
  } else {
    if (fileIndex >= 0) {
      environment.console.warn(`unable to find build file ${fileName}`)
    }

    program
      .command('init')
      .description('creates default build.yaml')
      .action(async () => {
        const content = `envs: {}

tasks:
  example:
    image: alpine
    cmds:
      - echo "it's Hammer Time!"
      `
        await environment.file.writeFile(fileName, content)
        environment.console.info(`created ${fileName}`)
      })
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  program.version(require('../package.json').version)
  program.option('--verbose', 'log debugging information', false)
  program.option('--file', 'set build file', 'build.yaml')
  program.name('hammerkit')

  return { program, args }
}
