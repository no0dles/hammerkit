import commaner, { Command } from 'commander'
import { join } from 'path'
import { isCI } from './ci'
import { parseBuildFile } from './parser/parse-build-file'
import { iterateWorkNodes, planWorkNodes } from './planner/utils/plan-work-nodes'
import { execute } from './executer/execute'
import { planWorkTree } from './planner/utils/plan-work-tree'
import { restore } from './executer/restore'
import { store } from './executer/store'
import { clean } from './executer/clean'
import { validate } from './planner/validate'
import { hideCursor, printWorkTreeResult, showCursor, writeWorkTreeStatus } from './log'
import { Context, ExecutionContext } from './run-arg'
import { emitter } from './emit'

export async function getProgram(context: Context): Promise<commaner.Command> {
  const program = new Command()
  const fileIndex = process.argv.indexOf('--file')

  const fileName = join(context.cwd, fileIndex >= 0 ? process.argv[fileIndex + 1] : 'build.yaml')

  if (await context.file.exists(fileName)) {
    const buildFile = await parseBuildFile(fileName, context)
    const workNodes = planWorkNodes(buildFile)
    const reservedCommands = ['clean', 'store', 'restore', 'validate']

    program
      .command('clean')
      .description('clear task cache')
      .action(async () => {
        try {
          await clean(workNodes, context)
        } catch (e) {
          context.console.error(e)
          process.exit(1)
        }
      })

    program
      .command('store <path>')
      .description('save task outputs into <path>')
      .action(async (path) => {
        try {
          await store(workNodes, path, context)
        } catch (e) {
          context.console.error(e)
          process.exit(1)
        }
      })

    program
      .command('restore <path>')
      .description('restore task outputs from <path>')
      .action(async (path) => {
        try {
          await restore(workNodes, path, context)
        } catch (e) {
          context.console.error(e)
          process.exit(1)
        }
      })

    program
      .command('validate')
      .description('validate build.yaml')
      .action(async () => {
        let errors = 0

        for await (const validation of validate(buildFile, context)) {
          if (validation.type === 'error') {
            errors++
            context.console.error(validation.message)
          } else {
            context.console.warn(validation.message)
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
        context.console.warn(`${node.name} is reserved, please use another name`)
        continue
      }

      program
        .command(node.name)
        .description(node.description || '')
        .option('-c, --concurrency <number>', 'parallel worker count', parseInt, 4)
        .option('-w, --watch', 'watch tasks', false)
        .option(
          '--cache <method>',
          'caching method to compare',
          /^(checksum|modify-date|none)$/,
          isCI ? 'checksum' : 'modify-date'
        )
        .option('--no-container', 'run every task locally without containers', false)
        .action(async (options) => {
          const executionContext: ExecutionContext = {
            workers: options.concurrency, // TODO rename
            cacheMethod: options.cacheMethod,
            noContainer: !options.container,
            watch: options.watch,
            events: emitter(),
            context,
            runningNodes: {},
          }

          let running = true
          let count = 0

          try {
            hideCursor()

            const workTree = planWorkTree(buildFile, node.name)
            writeWorkTreeStatus(workTree, count)

            const tickerFn = () => {
              count++
              writeWorkTreeStatus(workTree, count)
              if (running) {
                setTimeout(tickerFn, 100)
              }
            }
            tickerFn()

            executionContext.events.on(({ workTree }) => {
              writeWorkTreeStatus(workTree, count)
            })

            const result = await execute(workTree, executionContext)
            await printWorkTreeResult(workTree, result)

            if (!result.success) {
              process.exit(1)
            }
          } catch (e) {
            context.console.error(e)
            process.exit(1)
          } finally {
            running = false
            showCursor()
          }
        })
    }
  } else {
    if (fileIndex >= 0) {
      context.console.warn(`unable to find build file ${fileName}`)
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
        await context.file.writeFile(fileName, content)
        context.console.info(`created ${fileName}`)
      })
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  program.version(require('../package.json').version)
  program.option('--verbose', 'log debugging information', false)
  program.option('--file', 'set build file', 'build.yaml')
  program.name('hammerkit')

  return program
}
