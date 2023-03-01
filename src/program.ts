import commaner, { Command, Option } from 'commander'
import { join, relative, resolve } from 'path'
import { Environment } from './executer/environment'
import { isCI } from './utils/ci'
import { parseLabelArguments } from './parser/parse-label-arguments'
import { Cli, getCli, isCliService, isCliTask } from './cli'
import { WorkLabelScope, WorkScope } from './executer/work-scope'
import { printItem, printProperty, printTitle } from './log'
import { hasLabels } from './executer/label-values'
import { getBuildFilename } from './parser/default-build-file'
import { createParseContext } from './schema/schema-parser'
import { getWorkContext } from './schema/work-scope-parser'
import { parseReferences } from './schema/reference-parser'
import colors from 'colors'
import { WorkItemValidation } from './planner/work-item-validation'
import { getVersion } from './version'

export async function createCli(fileName: string, environment: Environment, workScope: WorkScope): Promise<Cli> {
  const { ctx, scope } = await createParseContext(fileName, environment)
  const referencedScope = await parseReferences(ctx, scope, environment)
  const workTree = await getWorkContext(referencedScope, workScope, environment)
  return getCli(workTree, environment)
}

function parseWorkLabelScope(options: unknown): WorkLabelScope {
  const scope: WorkLabelScope = {
    environmentName: null,
  }
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
    } else if (key === 'env') {
      scope.environmentName = `${value}`
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
  const fileName =
    fileIndex >= 0 ? join(environment.cwd, args[fileIndex + 1]) : await getBuildFilename(environment.cwd, environment)

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
        const cli = await createCli(fileName, environment, parseWorkLabelScope(options))
        const items = cli.ls()

        const tasks = items.filter(isCliTask)
        const services = items.filter(isCliService)

        if (services.length > 0) {
          printTitle(environment, 'Services')
          for (const service of services) {
            printItem(environment, service.item.data)
            printProperty(
              environment,
              'ports',
              service.item.data.ports.map((p) => `127.0.0.1:${p.hostPort} -> ${p.containerPort}`).join(', ')
            )
            if (service.item.data.type === 'kubernetes-service') {
              printProperty(environment, 'context', service.item.data.context)
              printProperty(
                environment,
                'selector',
                `${service.item.data.selector.type}/${service.item.data.selector.name}`
              )
            } else {
              printProperty(environment, 'image', service.item.data.image)
            }
          }
        }

        if (tasks.length > 0 && services.length > 0) {
          environment.stdout.write('\n')
        }

        if (tasks.length > 0) {
          printTitle(environment, 'Tasks')
          for (const task of tasks) {
            printItem(environment, task.item.data)
            if (task.item.needs.length > 0) {
              printProperty(environment, 'needs', task.item.needs.map((d) => d.name).join(', '))
            }
            if (task.item.deps.length > 0) {
              printProperty(environment, 'deps', task.item.deps.map((d) => d.name).join(', '))
            }
            if (task.item.data.type === 'container-task') {
              printProperty(environment, 'image', task.item.data.image)
            }
            if (task.item.data.caching) {
              printProperty(environment, 'caching', task.item.data.caching)
            }
            if (hasLabels(task.item.data.labels)) {
              printProperty(
                environment,
                'labels',
                `${Object.keys(task.item.data.labels)
                  .map((key) => `${key}=${task.item.data.labels[key].join(',')}`)
                  .join(' ')}`
              )
            }
            if (task.item.data.src.length > 0) {
              printProperty(
                environment,
                'src',
                task.item.data.src.map((d) => relative(task.item.data.cwd, d.absolutePath)).join(' ')
              )
            }
            if (task.item.data.generates.length > 0) {
              printProperty(
                environment,
                'generates',
                task.item.data.generates.map((d) => relative(task.item.data.cwd, d.path)).join(' ')
              )
            }
          }
        }
        environment.stdout.write('\n')
      })

    program
      .command('clean')
      .description('clear cache and generated')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (options) => {
        const cli = await createCli(fileName, environment, parseWorkLabelScope(options))
        await cli.clean()
      })

    program
      .command('store <path>')
      .description('save task outputs into <path>')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (path, options) => {
        const cli = await createCli(fileName, environment, parseWorkLabelScope(options))
        await cli.store(resolve(path))
      })

    program
      .command('restore <path>')
      .description('restore task outputs from <path>')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (path, options) => {
        const cli = await createCli(fileName, environment, parseWorkLabelScope(options))
        await cli.restore(resolve(path))
      })

    program
      .command('validate')
      .description('validate hammerkit configurations')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (options) => {
        let errors = 0

        const cli = await createCli(fileName, environment, parseWorkLabelScope(options))

        const fileErrors: { [buildFileName: string]: WorkItemValidation[] } = {}

        for await (const validation of cli.validate()) {
          if (!fileErrors[validation.item.scope.fileName]) {
            fileErrors[validation.item.scope.fileName] = [validation]
          } else {
            fileErrors[validation.item.scope.fileName].push(validation)
          }

          if (validation.type === 'error') {
            errors++
          }

          for (const [buildFilename, errors] of Object.entries(fileErrors)) {
            environment.stdout.write(`${colors.underline(colors.gray(buildFilename))}\n`)
            for (const error of errors) {
              environment.stdout.write(
                ` ${colors.underline(colors.blue(error.type))} at ${colors.gray(error.item.name)} ${error.message}\n`
              )
            }
            environment.stdout.write('\n')
          }
        }
        if (errors !== 0) {
          program.error('Detected errors in the hammerkit configuration', { exitCode: 1 })
        }
      })

    program
      .command('up')
      .description('start services(s)')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .addOption(new Option('-c, --concurrency <number>', 'parallel worker count').argParser(parseInt).default(4))
      .addOption(new Option('-w, --watch', 'watch tasks').default(false))
      .addOption(new Option('-d, --daemon', 'run services in background').default(false))
      .addOption(new Option('--env <name>', 'environment'))
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
      .action(async (options) => {
        const scope = parseWorkLabelScope(options)
        const cli = await createCli(fileName, environment, scope)
        const result = await cli.runUp({
          cacheDefault: options.cache,
          watch: options.watch,
          workers: options.concurrency,
          logMode: options.log,
          daemon: options.daemon,
        })

        if (!result.success) {
          program.error('Execution was not successful', { exitCode: 1 })
        } else {
          process.exit()
        }
      })

    program
      .command('down')
      .description('stop services(s)')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .addOption(new Option('--env <name>', 'environment'))
      .action(async (options) => {
        const scope = parseWorkLabelScope(options)
        const cli = await createCli(fileName, environment, scope)
        const result = await cli.runDown()

        if (!result.success) {
          program.error('Execution was not successful', { exitCode: 1 })
        }
      })

    program
      .command('run [task]', { isDefault: true })
      .description('execute task')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .addOption(new Option('-c, --concurrency <number>', 'parallel worker count').argParser(parseInt).default(4))
      .addOption(new Option('-w, --watch', 'watch tasks').default(false))
      .addOption(new Option('--env <name>', 'environment'))
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
        const cli = await createCli(
          fileName,
          environment,
          task ? { taskName: task, environmentName: options.env } : parseWorkLabelScope(options)
        )
        if (cli.tasks().length === 0) {
          program.error('No tasks found', { exitCode: 127 })
          return
        }

        const result = await cli.runExec({
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

  program.version(getVersion())
  program.option('--verbose', 'log debugging information', false)
  program.option('--file', 'set build file', '.hammerkit.yaml')
  program.configureOutput({
    writeOut: (str) => environment.console.info(str),
    writeErr: (str) => {
      environment.console.error(str)
    },
  })

  return { program, args }
}
