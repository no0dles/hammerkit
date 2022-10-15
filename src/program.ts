import commaner, { Command, Option } from 'commander'
import { join, resolve } from 'path'
import { Environment } from './executer/environment'
import { isCI } from './utils/ci'
import { parseLabelArguments } from './parser/parse-label-arguments'
import { Cli, getCli } from './testing/cli'
import { getBuildFile } from './parser/get-build-file'
import { emptyWorkLabelScope, WorkScope } from './executer/work-scope'
import { getWorkScope } from './get-work-context'

export async function createCli(fileName: string, environment: Environment, workScope: WorkScope): Promise<Cli> {
  const buildFile = await getBuildFile(fileName, environment)
  const workTree = getWorkScope(buildFile, workScope)
  return getCli(workTree, environment)
}

function parseWorkScope(options: unknown): WorkScope {
  const scope = emptyWorkLabelScope()
  if (typeof options !== 'object') {
    return scope
  }
  if (options === undefined || options === null) {
    return scope
  }

  for (const [key, value] of Object.entries(options)) {
    if (key === 'filter' && value instanceof Array) {
      scope.filterLabels = parseLabelArguments(value)
    } else if (key === 'exclude' && value instanceof Array) {
      scope.excludeLabels = parseLabelArguments(value)
    }
  }

  return scope
}

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
    program
      .command('ls')
      .description('list all tasks')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (options) => {
        try {
          const cli = await createCli(fileName, environment, parseWorkScope(options))
          for (const node of cli.ls()) {
            console.log(`${node.name} - ${node.description}`) // TODO formatting
          }
        } catch (e) {
          environment.console.error(e)
          process.exit(1)
        }
      })

    program
      .command('clean')
      .description('clear task cache')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (options) => {
        try {
          const cli = await createCli(fileName, environment, parseWorkScope(options))
          await cli.clean()
        } catch (e) {
          environment.console.error(e)
          process.exit(1)
        }
      })

    program
      .command('store <path>')
      .description('save task outputs into <path>')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (path, options) => {
        try {
          const cli = await createCli(fileName, environment, parseWorkScope(options))
          await cli.store(resolve(path))
        } catch (e) {
          environment.console.error(e)
          process.exit(1)
        }
      })

    program
      .command('restore <path>')
      .description('restore task outputs from <path>')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (path, options) => {
        try {
          const cli = await createCli(fileName, environment, parseWorkScope(options))
          await cli.restore(resolve(path))
        } catch (e) {
          environment.console.error(e)
          process.exit(1)
        }
      })

    program
      .command('validate')
      .description('validate build.yaml')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (options) => {
        let errors = 0

        const cli = await createCli(fileName, environment, parseWorkScope(options))
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
      .command('exec')
      .description('execute specific task')
      .arguments('<task>')
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
          const cli = await createCli(fileName, environment, { taskName: task })
          const result = await cli.exec({
            cacheDefault: options.cache,
            watch: options.watch,
            workers: options.concurrency,
            logMode: options.log,
            noContainer: !options.container,
          })

          if (!result.success) {
            process.exit(1)
          }
        } catch (e) {
          process.exit(1)
        }
      })

    program
      .command('up', { isDefault: true })
      .description('execute all tasks')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
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
          const cli = await createCli(fileName, environment, parseWorkScope(options))
          const result = await cli.exec({
            cacheDefault: options.cache,
            watch: options.watch,
            workers: options.concurrency,
            logMode: options.log,
            noContainer: !options.container,
          })

          if (!result.success) {
            process.exit(1)
          }
        } catch (e) {
          process.exit(1)
        }
      })
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
