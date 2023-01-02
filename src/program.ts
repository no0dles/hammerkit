import commaner, { Command, Option } from 'commander'
import { join, relative, resolve } from 'path'
import { Environment } from './executer/environment'
import { isCI } from './utils/ci'
import { parseLabelArguments } from './parser/parse-label-arguments'
import { Cli, getCli, isCliService, isCliTask } from './cli'
import { getBuildFile } from './parser/get-build-file'
import { emptyWorkLabelScope, WorkScope } from './executer/work-scope'
import { getWorkScope } from './get-work-context'
import { printItem, printProperty, printTitle } from './log'
import { hasLabels } from './executer/label-values'
import { getDefaultBuildFilename } from './parser/default-build-file'

export async function createCli(fileName: string, environment: Environment, workScope: WorkScope): Promise<Cli> {
  const buildFile = await getBuildFile(fileName, environment)
  const workTree = getWorkScope(buildFile, workScope, environment)
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
  const fileName = join(
    environment.cwd,
    fileIndex >= 0 ? args[fileIndex + 1] : await getDefaultBuildFilename(environment.cwd, environment)
  )
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
        const cli = await createCli(fileName, environment, parseWorkScope(options))
        const items = cli.ls()

        const tasks = items.filter(isCliTask)
        const services = items.filter(isCliService)

        if (services.length > 0) {
          printTitle(environment, 'Services')
          for (const node of services) {
            printItem(environment, node.item)
            printProperty(
              environment,
              'ports',
              node.item.ports.map((p) => `127.0.0.1:${p.hostPort} -> ${p.containerPort}`).join(', ')
            )
            if (node.item.type === 'kubernetes-service') {
              printProperty(environment, 'context', node.item.context)
              printProperty(environment, 'selector', `${node.item.selector.type}/${node.item.selector.name}`)
            } else {
              printProperty(environment, 'image', node.item.image)
            }
          }
        }

        if (tasks.length > 0 && services.length > 0) {
          environment.stdout.write('\n')
        }

        if (tasks.length > 0) {
          printTitle(environment, 'Tasks')
          for (const node of tasks) {
            printItem(environment, node.item)
            if (node.item.needs.length > 0) {
              printProperty(environment, 'needs', node.item.needs.map((d) => d.name).join(', '))
            }
            if (node.item.deps.length > 0) {
              printProperty(environment, 'deps', node.item.deps.map((d) => d.name).join(', '))
            }
            if (node.item.type === 'container') {
              printProperty(environment, 'image', node.item.image)
            }
            if (node.item.caching) {
              printProperty(environment, 'caching', node.item.caching)
            }
            if (hasLabels(node.item.labels)) {
              printProperty(
                environment,
                'labels',
                `${Object.keys(node.item.labels)
                  .map((key) => `${key}=${node.item.labels[key].join(',')}`)
                  .join(' ')}`
              )
            }
            if (node.item.src.length > 0) {
              printProperty(
                environment,
                'src',
                node.item.src.map((d) => relative(node.item.cwd, d.absolutePath)).join(' ')
              )
            }
            if (node.item.generates.length > 0) {
              printProperty(
                environment,
                'generates',
                node.item.generates.map((d) => relative(node.item.cwd, d.path)).join(' ')
              )
            }
          }
        }
        environment.stdout.write('\n')
      })

    program
      .command('clean')
      .description('clear task cache')
      .addOption(new Option('--service', 'clean data volumes of services'))
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (options) => {
        const cli = await createCli(fileName, environment, parseWorkScope(options))
        await cli.clean({
          service: options.service,
        })
      })

    program
      .command('store <path>')
      .description('save task outputs into <path>')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (path, options) => {
        const cli = await createCli(fileName, environment, parseWorkScope(options))
        await cli.store(resolve(path))
      })

    program
      .command('restore <path>')
      .description('restore task outputs from <path>')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (path, options) => {
        const cli = await createCli(fileName, environment, parseWorkScope(options))
        await cli.restore(resolve(path))
      })

    program
      .command('validate')
      .description('validate hammerkit configurations')
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
        if (errors !== 0) {
          program.error('Detected errors in the hammerkit configuration', { exitCode: 1 })
        }
      })

    program
      .command('shutdown')
      .description('end all container tasks/services')
      .arguments('[task]')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (task, options) => {
        const cli = await createCli(fileName, environment, task ? { taskName: task } : parseWorkScope(options))
        cli.shutdown()
      })

    program
      .command('exec', { isDefault: true })
      .description('execute task(s)')
      .arguments('[task]')
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
      .action(async (task, options) => {
        const cli = await createCli(fileName, environment, task ? { taskName: task } : parseWorkScope(options))
        const result = await cli.exec({
          cacheDefault: options.cache,
          watch: options.watch,
          workers: options.concurrency,
          logMode: options.log,
        })

        if (!result.success) {
          program.error('Execution was not successful', { exitCode: 1 })
        }
      })
  } else {
    if (fileIndex >= 0) {
      environment.console.warn(`unable to find build file ${fileName}`)
    }

    program
      .command('init')
      .description('creates default .hammerkit.yaml')
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
  program.option('--file', 'set build file', '.hammerkit.yaml')
  program.configureOutput({
    writeOut: (str) => environment.console.info(str),
    writeErr: (str) => environment.console.error(str),
  })

  return { program, args }
}
