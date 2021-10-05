import commaner, { Command, Option } from 'commander'
import { join, resolve } from 'path'
import { getBuildFile } from './parser/get-build-file'
import { iterateWorkNodes, planWorkNodes } from './planner/utils/plan-work-nodes'
import { execute } from './executer/execute'
import { planWorkTree } from './planner/utils/plan-work-tree'
import { restore } from './executer/restore'
import { store } from './executer/store'
import { clean } from './executer/clean'
import { validate } from './planner/validate'
import { Environment } from './executer/environment'
import { ExecutionContext } from './executer/execution-context'
import { getLocalExecutor } from './executer/get-local-executor'
import { getDockerExecutor } from './executer/get-docker-executor'
import { getLogger } from './logging/get-logger'
import { isCI } from './utils/ci'
import { emitter } from './utils/emitter'

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
    const buildFile = await getBuildFile(fileName, environment)
    const [workNodes, workServices] = planWorkNodes(buildFile) // TODO make them accessable trough cli
    const reservedCommands = ['clean', 'store', 'restore', 'validate']

    program
      .command('clean')
      .description('clear task cache')
      .action(async () => {
        try {
          await clean(workNodes, environment, await getDockerExecutor())
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
          await store(workNodes, resolve(path), environment, await getDockerExecutor())
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
          await restore(workNodes, resolve(path), environment, await getDockerExecutor())
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

        for await (const validation of validate(buildFile, environment)) {
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

    for (const node of iterateWorkNodes(workNodes)) {
      if (reservedCommands.indexOf(node.name) >= 0) {
        environment.console.warn(`${node.name} is reserved, please use another name`)
        continue
      }

      program
        .command(node.name)
        .description(node.description || '')
        .option('-c, --concurrency <number>', 'parallel worker count', parseInt, 4)
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
        .action(async (options) => {
          const logger = getLogger(options.log)

          try {
            const executionContext: ExecutionContext = {
              workers: options.concurrency, // TODO rename
              cacheMethod: options.cache,
              watch: options.watch,
              events: emitter(),
              executor: options.container ? await getDockerExecutor() : getLocalExecutor(),
              environment: environment,
            }

            const workTree = planWorkTree(buildFile, node.name)
            logger.start(executionContext, workTree)
            const result = await execute(workTree, executionContext)
            await logger.finish(workTree, result)

            if (!result.success) {
              process.exit(1)
            }
          } catch (e) {
            logger.abort(e)
            process.exit(1)
          }
        })
    }
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
