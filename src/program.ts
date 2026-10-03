import commaner, { Command, CommanderError, Option } from 'commander'
import { join, relative, resolve } from 'path'
import { Environment } from './executer/environment'
import { isCI } from './utils/ci'
import { parseLabelArguments } from './parser/parse-label-arguments'
import { Cli, getCli, isCliService, isCliTask } from './cli'
import { WorkLabelScope, WorkScope } from './executer/work-scope'
import { consoleContext, getErrorMessage, printItem, printProperty, printTitle } from './log'
import { emptyWritable } from './utils/empty-writable'
import { describeCause } from './cache/explain'
import { printRunSummary, summarizeRun } from './executer/run-summary'
import { printDryRun } from './executer/dry-run'
import { hasLabels } from './executer/label-values'
import { getBuildFilename } from './parser/default-build-file'
import { createParseContext } from './schema/schema-parser'
import { getWorkContext } from './schema/work-scope-parser'
import { parseReferences } from './schema/reference-parser'
import colors from 'colors'
import { WorkItemValidation } from './planner/work-item-validation'
import { getVersion } from './version'
import { CACHE_READ_ONLY_ENV, isCacheReadOnly } from './cache/read-only'
import { formatDuration, formatSize, parseDuration, parseSize } from './utils/units'
import { hasPolicy, NamedCacheEntry } from './cache/cache-inventory'

export async function createCli(fileName: string, environment: Environment, workScope: WorkScope): Promise<Cli> {
  const { ctx, scope } = await createParseContext(fileName, environment)
  const referencedScope = await parseReferences(ctx, scope, environment)
  const workTree = getWorkContext(referencedScope, workScope, environment)
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
              const c = task.item.data.caching
              printProperty(environment, 'caching', `${c.name} (${c.method}, ${c.backend.type})`)
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
      .addOption(
        new Option(
          '--cache',
          'also clear stored cache results from the backend (e.g. the local ~/.hammerkit/remote-cache or a configured remote bucket)'
        )
      )
      .action(async (options) => {
        try {
          const cli = await createCli(fileName, environment, parseWorkLabelScope(options))
          await cli.clean({ cache: !!options.cache })
        } catch (e) {
          if (e instanceof CommanderError) {
            throw e
          }

          environment.console.error(getErrorMessage(e))
          program.error('Clean was not successful', { exitCode: 1 })
        }
      })

    program
      .command('store <directory>')
      .description('save task outputs into <directory>')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (path, options) => {
        try {
          const cli = await createCli(fileName, environment, parseWorkLabelScope(options))
          await cli.store(resolve(path))
        } catch (e) {
          if (e instanceof CommanderError) {
            throw e
          }

          environment.console.error(getErrorMessage(e))
          program.error('Store was not successful', { exitCode: 1 })
        }
      })

    program
      .command('restore <directory>')
      .description('restore task outputs from <directory>')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .action(async (path, options) => {
        try {
          const cli = await createCli(fileName, environment, parseWorkLabelScope(options))
          await cli.restore(resolve(path))
        } catch (e) {
          if (e instanceof CommanderError) {
            throw e
          }

          environment.console.error(getErrorMessage(e))
          program.error('Restore was not successful', { exitCode: 1 })
        }
      })

    program
      .command('package <registry>')
      .description('package services into a docker image')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .addOption(new Option('--push', 'push image to registry').default(false))
      .addOption(new Option('--build-override-user', 'set a dedicated user (uid/gid)').default(false))
      .addOption(new Option('-t, --tag <tag>', 'image tag').default('latest'))
      .addOption(new Option('--platform <platform>', 'target build platform, e.g. linux/amd64'))
      .addOption(new Option('-u, --user, --username', 'registry username'))
      .addOption(new Option('-p, --password', 'registry password'))
      .action(async (registry, options) => {
        try {
          const cli = await createCli(fileName, environment, parseWorkLabelScope(options))
          await cli.package({
            registry,
            push: options.push,
            overrideUser: !!options.overrideUser,
            username: options.username,
            password: options.password,
            tag: options.tag,
            platform: options.platform,
          })
        } catch (e) {
          if (e instanceof CommanderError) {
            throw e
          }

          environment.console.error(getErrorMessage(e))
          program.error('Package was not successful', { exitCode: 1 })
        }
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
        if (errors !== 0) {
          program.error('Detected errors in the hammerkit configuration', { exitCode: 1 })
        }
      })

    program
      .command('graph [task]')
      .description('serialize the build graph (tasks, services, deps/needs edges) as mermaid or dot')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .addOption(new Option('--env <name>', 'environment'))
      .addOption(new Option('--format <format>', 'output format').default('mermaid').choices(['mermaid', 'dot']))
      .action(async (task, options) => {
        try {
          const cli = await createCli(
            fileName,
            environment,
            task ? { taskName: task, environmentName: options.env ?? null } : parseWorkLabelScope(options)
          )
          const serialization = cli.graph(options.format)
          environment.stdout.write(`${serialization.output}\n`)
          if (serialization.cycle) {
            environment.console.warn(`cycle detected: ${serialization.cycle.join(' -> ')}`)
          }
        } catch (e) {
          if (e instanceof CommanderError) {
            throw e
          }

          environment.console.error(getErrorMessage(e))
          program.error('Graph was not successful', { exitCode: 1 })
        }
      })

    program
      .command('explain [task]')
      .description('explain whether tasks would be a cache hit or miss, without running them')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .addOption(new Option('--env <name>', 'environment'))
      .addOption(
        new Option('--cache <method>', 'caching method to compare')
          .default('checksum')
          .choices(['checksum', 'modify-date', 'none'])
      )
      .addOption(new Option('--json', 'emit the explanation as JSON').default(false))
      .action(async (task, options) => {
        try {
          const cli = await createCli(
            fileName,
            environment,
            task ? { taskName: task, environmentName: options.env ?? null } : parseWorkLabelScope(options)
          )
          const explanations = await cli.explain({ cacheDefault: options.cache })
          if (options.json) {
            environment.stdout.write(`${JSON.stringify(explanations, null, 2)}\n`)
            return
          }
          for (const explanation of explanations) {
            const label =
              explanation.status === 'hit'
                ? colors.green('cache hit')
                : explanation.status === 'uncacheable'
                  ? colors.grey('uncacheable')
                  : colors.yellow('cache miss')
            environment.stdout.write(`• ${explanation.taskName}: ${label}\n`)
            for (const cause of explanation.causes) {
              printProperty(environment, 'cause', describeCause(cause))
            }
          }
        } catch (e) {
          if (e instanceof CommanderError) {
            throw e
          }

          environment.console.error(getErrorMessage(e))
          program.error('Explain was not successful', { exitCode: 1 })
        }
      })

    const cacheCommand = program.command('cache').description('inspect, prune and move cache entries')
    for (const direction of ['pull', 'push'] as const) {
      cacheCommand
        .command(`${direction} [task]`)
        .description(
          direction === 'pull'
            ? 'fetch the cache entries of the current state from a remote cache, without running tasks'
            : 'upload the locally cached entries of the current state to a remote cache, without running tasks'
        )
        .addOption(new Option('--remote <name>', 'remote cache declared in the caches block').makeOptionMandatory())
        .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
        .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
        .addOption(new Option('--env <name>', 'environment'))
        .addOption(
          new Option('--cache <method>', 'caching method to compare')
            .default('checksum')
            .choices(['checksum', 'modify-date', 'none'])
        )
        .action(async (task, options) => {
          try {
            if (direction === 'push' && isCacheReadOnly(false, environment.processEnvs)) {
              program.error(`cache is read-only (${CACHE_READ_ONLY_ENV} is set), refusing to push`, { exitCode: 1 })
              return
            }
            const cli = await createCli(
              fileName,
              environment,
              task ? { taskName: task, environmentName: options.env ?? null } : parseWorkLabelScope(options)
            )
            const results = await cli.syncCache({ direction, remote: options.remote, cacheDefault: options.cache })
            const labels = {
              transferred: colors.green(direction === 'pull' ? 'pulled' : 'pushed'),
              present: colors.grey('already present'),
              missing: colors.yellow(direction === 'pull' ? 'not in remote' : 'not in local cache'),
              skipped: colors.grey('skipped'),
            }
            for (const result of results) {
              environment.stdout.write(`• ${result.taskName}: ${labels[result.status]}\n`)
            }
            const moved = results.filter((r) => r.status === 'transferred').length
            environment.stdout.write(
              `${moved}/${results.length} entries ${direction === 'pull' ? 'pulled' : 'pushed'}\n`
            )
          } catch (e) {
            if (e instanceof CommanderError) {
              throw e
            }
            environment.console.error(getErrorMessage(e))
            program.error(`Cache ${direction} was not successful: ${getErrorMessage(e)}`, { exitCode: 1 })
          }
        })
    }

    const describeEntry = (entry: NamedCacheEntry) =>
      `${entry.taskName ?? colors.grey(entry.taskId.substring(0, 12))} ${colors.grey(
        entry.stateKey.substring(0, 12)
      )} ` +
      `${entry.size === null ? '?' : formatSize(entry.size)}` +
      (entry.lastAccessedAt ?? entry.createdAt
        ? colors.grey(` last used ${formatDuration(Date.now() - (entry.lastAccessedAt ?? entry.createdAt ?? 0))} ago`)
        : '')
    const totalSize = (entries: NamedCacheEntry[]) =>
      formatSize(entries.reduce((sum, entry) => sum + (entry.size ?? 0), 0))
    const countOf = (count: number) => `${count} ${count === 1 ? 'entry' : 'entries'}`

    cacheCommand
      .command('ls')
      .description('list the entries of a cache (default: the local default cache)')
      .addOption(new Option('--remote <name>', 'cache declared in the caches block to list'))
      .addOption(new Option('--json', 'emit the entries as JSON').default(false))
      .action(async (options) => {
        try {
          const cli = await createCli(fileName, environment, parseWorkLabelScope({}))
          const entries = await cli.listCache(options.remote)
          if (options.json) {
            environment.stdout.write(`${JSON.stringify(entries, null, 2)}\n`)
            return
          }
          for (const entry of entries) {
            environment.stdout.write(`• ${describeEntry(entry)}\n`)
          }
          environment.stdout.write(`${countOf(entries.length)}, ${totalSize(entries)} total\n`)
        } catch (e) {
          if (e instanceof CommanderError) {
            throw e
          }
          program.error(`Cache ls was not successful: ${getErrorMessage(e)}`, { exitCode: 1 })
        }
      })

    cacheCommand
      .command('prune')
      .description('remove cache entries by retention policy (default: the local default cache)')
      .addOption(new Option('--remote <name>', 'cache declared in the caches block to prune'))
      .addOption(
        new Option('--max-age <duration>', 'remove entries not used within this long (e.g. 30d)').argParser(
          parseDuration
        )
      )
      .addOption(
        new Option('--max-size <size>', 'remove least recently used entries above this size (e.g. 5Gi)').argParser(
          parseSize
        )
      )
      .addOption(
        new Option('--keep <count>', 'keep only the newest versions per task').argParser((v) => parseInt(v, 10))
      )
      .addOption(new Option('--dry-run', 'show what would be removed without removing it').default(false))
      .action(async (options) => {
        try {
          const cli = await createCli(fileName, environment, parseWorkLabelScope({}))
          const policy = cli.retentionPolicy(options.remote, {
            maxAge: options.maxAge,
            maxSize: options.maxSize,
            keepPerTask: options.keep,
          })
          if (!hasPolicy(policy)) {
            program.error(
              'no retention policy: pass --max-age, --max-size or --keep, or declare retention on the cache',
              { exitCode: 1 }
            )
            return
          }
          const plan = await cli.pruneCache(options.remote, policy, options.dryRun)
          for (const entry of plan.evict) {
            environment.stdout.write(`• ${options.dryRun ? 'would remove' : 'removed'} ${describeEntry(entry)}\n`)
          }
          for (const note of plan.unavailable) {
            environment.console.warn(note)
          }
          environment.stdout.write(
            `${options.dryRun ? 'would remove' : 'removed'} ${countOf(plan.evict.length)} (${totalSize(
              plan.evict
            )}), ` + `kept ${countOf(plan.keep.length)} (${totalSize(plan.keep)})\n`
          )
        } catch (e) {
          if (e instanceof CommanderError) {
            throw e
          }
          program.error(`Cache prune was not successful: ${getErrorMessage(e)}`, { exitCode: 1 })
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
          .default('checksum')
          .choices(['checksum', 'modify-date', 'none'])
      )
      .addOption(
        new Option(
          '--cache-read-only',
          `restore from cache backends but never push to them (or set ${CACHE_READ_ONLY_ENV}=1)`
        ).default(false)
      )
      .addOption(
        new Option('--timeout <duration>', 'fail tasks without their own timeout after this long (e.g. 10m)').argParser(
          parseDuration
        )
      )
      .action(async (options) => {
        try {
          const scope = parseWorkLabelScope(options)
          const cli = await createCli(fileName, environment, scope)
          const result = await cli.runUp({
            cacheDefault: options.cache,
            watch: options.watch,
            workers: options.concurrency,
            logMode: options.log,
            daemon: options.daemon,
            cacheReadOnly: isCacheReadOnly(options.cacheReadOnly, environment.processEnvs),
            timeout: options.timeout ?? null,
          })

          if (!result.success) {
            program.error('Up was not successful', { exitCode: 1 })
          } else {
            process.exit()
          }
        } catch (e) {
          if (e instanceof CommanderError) {
            throw e
          }

          environment.console.error(getErrorMessage(e))
          program.error('Up was not successful', { exitCode: 1 })
        }
      })

    program
      .command('down')
      .description('stop services(s)')
      .addOption(new Option('-f, --filter <labels...>', 'filter task and services with labels'))
      .addOption(new Option('-e, --exclude <labels...>', 'exclude task and services with labels'))
      .addOption(new Option('--env <name>', 'environment'))
      .action(async (options) => {
        try {
          const scope = parseWorkLabelScope(options)
          const cli = await createCli(fileName, environment, scope)
          const result = await cli.runDown()

          if (!result.success) {
            program.error('Shutdown was not successful', { exitCode: 1 })
          }
        } catch (e) {
          if (e instanceof CommanderError) {
            throw e
          }

          environment.console.error(getErrorMessage(e))
          program.error('Shutdown was not successful', { exitCode: 1 })
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
          .default('checksum')
          .choices(['checksum', 'modify-date', 'none'])
      )
      .addOption(new Option('--no-summary', 'do not print the end-of-run summary'))
      .addOption(new Option('--summary-json', 'emit the end-of-run summary as JSON').default(false))
      .addOption(new Option('--explain', 'print the cache-miss cause when a task rebuilds').default(false))
      .addOption(
        new Option('--dry-run', 'print the execution plan with predicted cache hits/misses without running').default(
          false
        )
      )
      .addOption(
        new Option(
          '--cache-read-only',
          `restore from cache backends but never push to them (or set ${CACHE_READ_ONLY_ENV}=1)`
        ).default(false)
      )
      .addOption(
        new Option('--timeout <duration>', 'fail tasks without their own timeout after this long (e.g. 10m)').argParser(
          parseDuration
        )
      )
      .addOption(new Option('--no-skip-deps', 'run dependencies even when every task needing them is a cache hit'))
      .action(async (task, options) => {
        try {
          // For machine-readable JSON, suppress the human progress logger (which
          // also writes to stdout) so the only thing on stdout is the JSON.
          const runEnvironment: Environment = options.summaryJson
            ? { ...environment, stdout: emptyWritable(), console: consoleContext(emptyWritable()) }
            : environment
          const cli = await createCli(
            fileName,
            runEnvironment,
            task ? { taskName: task, environmentName: options.env } : parseWorkLabelScope(options)
          )
          if (cli.tasks().length === 0) {
            program.error('No tasks found', { exitCode: 127 })
            return
          }

          if (options.dryRun) {
            const plan = await cli.dryRun({ cacheDefault: options.cache })
            if (plan.cycle) {
              program.error(`task cycle detected ${plan.cycle.join(' -> ')}`, { exitCode: 1 })
              return
            }
            printDryRun(environment, plan)
            return
          }

          const runStart = Date.now()
          const result = await cli.runExec({
            cacheDefault: options.cache,
            watch: options.watch,
            workers: options.concurrency,
            logMode: options.log,
            explain: options.explain,
            cacheReadOnly: isCacheReadOnly(options.cacheReadOnly, environment.processEnvs),
            timeout: options.timeout ?? null,
            skipDeps: options.skipDeps !== false,
          })

          // Reporting only: the summary never changes the exit code or behavior.
          if (!options.watch) {
            const summary = summarizeRun(result.state, Date.now() - runStart)
            if (options.summaryJson) {
              environment.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
            } else if (options.summary !== false) {
              printRunSummary(environment, summary)
            }
          }

          if (!result.success) {
            program.error('Execution was not successful', { exitCode: 1 })
          }

          // Declared retention keeps local caches bounded without anyone having
          // to remember `cache prune`. Never on remotes, never in read-only mode.
          if (!options.watch && !isCacheReadOnly(options.cacheReadOnly, environment.processEnvs)) {
            try {
              for (const { cacheName, plan } of await cli.autoPrune()) {
                if (plan.evict.length > 0) {
                  runEnvironment.console.info(
                    `pruned ${plan.evict.length} old ${
                      plan.evict.length === 1 ? 'entry' : 'entries'
                    } from cache "${cacheName}"`
                  )
                }
              }
            } catch (e) {
              runEnvironment.console.warn(`automatic cache prune failed: ${getErrorMessage(e)}`)
            }
          }
        } catch (e) {
          if (e instanceof CommanderError) {
            throw e
          }
          program.error(getErrorMessage(e), { exitCode: 1 })
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
