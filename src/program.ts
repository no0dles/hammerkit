import commaner, { Command } from 'commander'
import { existsSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'
import consola, { LogLevel } from 'consola'
import { RunArg } from './run-arg'
import { Defer } from './defer'
import { isCI } from './ci'
import { parseBuildFile } from './parser/parse-build-file'
import { planWorkNodes } from './planner/utils/plan-work-nodes'
import { execute } from './executer/execute'
import { planWorkTree } from './planner/utils/plan-work-tree'
import { restore } from './executer/restore'
import { store } from './executer/store'
import { clean } from './executer/clean'
import { validate } from './planner/validate'

export function getProgram(cwd: string): commaner.Command {
  const program = new Command()
  const isVerbose = process.argv.some((a) => a === '--verbose')
  const fileIndex = process.argv.indexOf('--file')

  const fileName = join(cwd, fileIndex >= 0 ? process.argv[fileIndex + 1] : 'build.yaml')

  console.log(fileName)

  if (isVerbose) {
    consola.level = LogLevel.Debug
  }

  if (existsSync(fileName)) {
    const buildFile = parseBuildFile(fileName)
    const reservedCommands = ['clean', 'store', 'restore', 'validate']

    program
      .command('clean')
      .description('clear task cache')
      .action(async () => {
        try {
          await clean(buildFile)
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
          await store(buildFile, path)
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
          await restore(buildFile, path)
        } catch (e) {
          consola.error(e)
          process.exit(1)
        }
      })

    program
      .command('validate')
      .description('validate build.yaml')
      .action(async () => {
        let errors = 0

        for (const validation of validate(buildFile)) {
          const logger = consola.withTag(validation.node.name)
          if (validation.type === 'error') {
            errors++
            logger.error(validation.message)
          } else {
            logger.warn(validation.message)
          }
        }
        if (errors === 0) {
          process.exit(0)
        } else {
          process.exit(1)
        }
      })

    const tasks = planWorkNodes(buildFile)
    for (const key of Object.keys(tasks)) {
      const task = tasks[key]
      if (reservedCommands.indexOf(task.name) >= 0) {
        consola.warn(`${task.name} is reserved, please use another name`)
        continue
      }

      program
        .command(task.name)
        .description(task.description || '')
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
          const runArg: RunArg = {
            logger: consola,
            workers: options.concurrency,
            processEnvs: process.env,
            cacheMethod: options.cacheMethod,
            noContainer: !options.container,
            cancelPromise: new Defer<void>(),
            watch: options.watch,
          }

          process.on('SIGINT', function () {
            if (!runArg.cancelPromise.isResolved) {
              runArg.cancelPromise.resolve()
            }
          })

          if (options.verbose) {
            runArg.logger.level = LogLevel.Debug
          }

          try {
            const workTree = planWorkTree(buildFile, task.name)
            const result = await execute(workTree, runArg)
            for (const key of Object.keys(result.nodes)) {
              const task = result.nodes[key]
              consola.info(`[${task.type}] ${workTree.nodes[key].name}`)
            }

            if (!result.success) {
              process.exit(1)
            }
          } catch (e) {
            consola.error(e)
            process.exit(1)
          }
        })
    }
  } else {
    if (fileIndex >= 0) {
      consola.warn(`unable to find build file ${fileName}`)
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
        writeFileSync(fileName, content)
        consola.success(`created ${fileName}`)

        const gitIgnoreFile = join(process.cwd(), '.gitignore')
        const gitIgnoreContent = `.hammerkit\n`
        if (existsSync(gitIgnoreFile)) {
          appendFileSync(gitIgnoreFile, gitIgnoreContent)
          consola.success(`extened ${gitIgnoreFile} with hammerkit cache directory`)
        } else {
          writeFileSync(gitIgnoreFile, gitIgnoreContent)
          consola.success(`created ${gitIgnoreFile} with hammerkit cache directory`)
        }
      })
  }

  // eslint-disable-next-line @typescript-eslint/no-var-requires
  program.version(require('../package.json').version)
  program.option('--verbose', 'log debugging information', false)
  program.option('--file', 'set build file', 'build.yaml')
  program.name('hammerkit')

  return program
}
